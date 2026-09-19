import pino from "pino";
import { AppLogBuffer, type AppLogEvent } from "./buffer.js";
import type { AppEvent, AppLog } from "./port.js";
import { NULL_LOG } from "./port.js";
import { LogSink } from "./sink.js";

export interface CreateAppLogOptions {
  level: string;
  dir: string;
  maxBytes: number;
  /** Called for every event written, for the live UI feed. */
  onEvent?: (event: AppLogEvent) => void;
}

export interface AppLogHandle {
  log: AppLog;
  buffer: AppLogBuffer;
  /**
   * Whether anything is actually being recorded.
   *
   * Reported here rather than left for callers to infer from the level,
   * so "switched off" and "on but quiet" stay distinguishable all the
   * way to the UI. They look identical from the outside -- no file, no
   * events -- and only this flag tells them apart, which is the
   * difference between a panel that says it is disabled and one that
   * looks broken.
   */
  enabled: boolean;
  /** Flushes and closes the file. Must be awaited before the process exits. */
  close(): Promise<void>;
}

/**
 * Builds the real app event log: a file, a ring for the UI, and a live feed.
 *
 * `silent` is a genuine off switch rather than a filter: no file is
 * opened, no directory is created and the returned log is the same
 * no-op every consumer already falls back to. A production box set to
 * silent therefore costs nothing at all -- not an open handle, not a
 * level comparison per call.
 */
export function createAppLog(options: CreateAppLogOptions): AppLogHandle {
  const buffer = new AppLogBuffer();

  if (options.level === "silent") {
    return { log: NULL_LOG, buffer, enabled: false, close: async () => {} };
  }

  const sink = new LogSink({ dir: options.dir, maxBytes: options.maxBytes });

  // Seed from the tail of the file before anything new is written, so a
  // backend restart does not blank the view. This is the main advantage
  // over the miner's log buffer, which starts empty every boot -- and an
  // auto-restart is one of the moments you most want to look back at.
  buffer.seed(sink.readTail().slice(-500));

  /**
   * Both destinations see the SAME serialised line.
   *
   * The ring parses back what pino just wrote rather than capturing the
   * object beforehand, so the UI cannot drift from the file: same
   * serialisers, same level names, same time, same redaction. Diverging
   * the two is how you end up debugging the logger instead of the app.
   */
  const destination = {
    write(line: string): void {
      sink.write(line);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // pino produced something unparseable, which should not happen.
        // The file still has it; the UI simply skips it rather than
        // taking the process down over a log line.
        return;
      }
      const event = parsed as AppLogEvent;
      buffer.push(event);
      options.onEvent?.(event);
    },
  };

  const logger = pino(
    {
      level: options.level,
      // pid and hostname on every line of a single-process app are noise.
      base: null,
      // `msg` is what the AppEvent port already calls its sentence.
      messageKey: "msg",
      formatters: {
        // Level as its name rather than pino's numeric code: the file is
        // meant to be read with jq and grep by a human, and `"level":30`
        // is not something anyone should have to memorise.
        level: (label) => ({ level: label }),
      },
    },
    destination,
  );

  return { log: wrap(logger), buffer, enabled: true, close: () => sink.close() };
}

/** Adapts a pino logger to the narrow port the app codes against. */
function wrap(logger: pino.Logger): AppLog {
  return {
    debug: (event: AppEvent) => logger.debug(event),
    info: (event: AppEvent) => logger.info(event),
    warn: (event: AppEvent) => logger.warn(event),
    error: (event: AppEvent) => logger.error(event),
    child: (bindings) => wrap(logger.child(bindings)),
  };
}
