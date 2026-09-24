import {
  closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync,
} from "node:fs";
import { join } from "node:path";
// pino's own file writer (a sonic-boom destination under the hood),
// reached through pino rather than by importing sonic-boom directly:
// sonic-boom is CommonJS whose .d.ts declares a default export, which
// `verbatimModuleSyntax` will not synthesise, and a named import
// typechecks but throws at runtime under plain Node. pino.destination()
// is the supported API, has the same surface, and keeps the writer on
// exactly the version pino itself uses.
import pino from "pino";
import type { AppLogEvent } from "./buffer.js";

/** The live log, and the one previous generation kept beside it. */
export const LOG_NAME = "app.ndjson";
export const PREVIOUS_NAME = "app.ndjson.1";

/**
 * How much of the file is read back at boot to repopulate the UI.
 *
 * 256 KiB is a few thousand events -- comfortably more than the ring
 * holds, so the ring fills and the excess is discarded rather than the
 * read being the limiting factor. Reading the whole file instead would
 * make boot time scale with a log that is allowed to reach megabytes,
 * for events nobody can see anyway.
 */
export const TAIL_BYTES = 262_144;

/** The writer surface this sink needs, which pino.destination() satisfies. */
type Destination = ReturnType<typeof pino.destination>;

export interface SinkOptions {
  dir: string;
  maxBytes: number;
}

/**
 * The app event log's file, with size-capped rotation.
 *
 * Writes through sonic-boom -- pino's own writer, already installed --
 * rather than pino-roll, whose worker thread is a known way to lose
 * lines at process exit. Exit is exactly when the most valuable events
 * are written (a crash, a give-up, a shutdown), so the writer has to be
 * one we can flush synchronously on the way out.
 */
export class LogSink {
  private boom: Destination;
  private bytes: number;
  private closed = false;

  constructor(private readonly options: SinkOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.bytes = sizeOf(this.path);
    this.boom = this.open();
  }

  private get path(): string {
    return join(this.options.dir, LOG_NAME);
  }

  private open(): Destination {
    // append: a restart continues the current file rather than truncating
    // it, which is what makes the boot tail-read able to show events from
    // before the restart.
    //
    // sync: the file descriptor is opened synchronously, so flushSync()
    // works from the first write. In async mode sonic-boom opens the fd
    // on a tick of its own and flushSync() throws "sonic boom is not
    // ready yet" until it lands -- which meant every rotation and every
    // shutdown silently discarded whatever was still buffered, losing
    // exactly the crash and give-up events this log exists to keep.
    // Measured at 2.9us per write against 3.1us async (10k writes), so
    // the async mode was not buying anything here either: at this log's
    // volume -- tens of events an hour, not thousands a second -- the
    // syscall is far cheaper than the machinery to defer it.
    return pino.destination({ dest: this.path, append: true, sync: true });
  }

  /**
   * Appends one already-serialised NDJSON line.
   *
   * The size check runs AFTER the write, so the cap is a soft one: a
   * line is never split across two files, and rotation never has to
   * predict how long a line will be.
   */
  write(line: string): void {
    // Shutdown closes the file while boot work can still be settling, and
    // its failure handler logs. sonic-boom throws on a write after end(),
    // and that throw would crash the process on its way out -- so a late
    // line is dropped instead.
    if (this.closed) return;
    this.boom.write(line);
    this.bytes += Buffer.byteLength(line);
    if (this.bytes >= this.options.maxBytes) this.rotate();
  }

  private rotate(): void {
    const previous = join(this.options.dir, PREVIOUS_NAME);
    // Writes are synchronous, so everything logged so far is already on
    // disk and the rename below cannot strand buffered lines in the
    // wrong generation.
    this.boom.destroy();
    try {
      // Only ONE previous generation is kept. rename replaces an existing
      // destination, so the older one is dropped here rather than
      // accumulating app.ndjson.2, .3 and so on with nothing to prune them.
      rmSync(previous, { force: true });
      renameSync(this.path, previous);
    } catch {
      // Rotation failed (a permission change, a file held open elsewhere).
      // Reopening below on the same path is still right: worst case the
      // file keeps growing past the cap, which is better than the app
      // losing its log entirely over a failed rename.
    }
    this.bytes = sizeOf(this.path);
    this.boom = this.open();
  }

  /**
   * Closes the file. Called on shutdown, before the process exits.
   *
   * Writes are synchronous so there is nothing buffered to lose, but the
   * handle is still closed properly rather than left to the process
   * teardown -- and close() resolves on either outcome, because a
   * shutdown must never hang waiting on a log file.
   */
  close(): Promise<void> {
    this.closed = true;
    return new Promise((resolve) => {
      this.boom.once("close", () => resolve());
      this.boom.once("error", () => resolve());
      this.boom.end();
    });
  }

  /** The tail of the current file, oldest first, for seeding the ring. */
  readTail(): AppLogEvent[] {
    return readTail(this.path);
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Parses the last TAIL_BYTES of an NDJSON log into events.
 *
 * Every failure mode here is survivable and none may throw: this runs at
 * boot, and a malformed log file must not be able to stop the app from
 * starting. A read that lands mid-line leaves a partial first line, which
 * is dropped; a line torn by a previous hard kill is skipped.
 */
export function readTail(path: string, maxBytes = TAIL_BYTES): AppLogEvent[] {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    // A partial first line is only possible when the read started past the
    // beginning of the file; reading the whole file starts on a boundary.
    if (length < size) lines.shift();
    const events: AppLogEvent[] = [];
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isEvent(parsed)) events.push(parsed);
      } catch {
        // A torn line from a hard kill. Skipping it loses one event;
        // throwing would lose the whole log and the boot with it.
      }
    }
    return events;
  } catch {
    // No file yet (first run), or it cannot be read. Either way there is
    // no history to show, which is not an error.
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Already closed or never opened.
      }
    }
  }
}

/** Whether a parsed line carries the fields a reader needs to render it. */
function isEvent(value: unknown): value is AppLogEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  return typeof event.type === "string"
    && typeof event.level === "string"
    && typeof event.time === "number";
}

/** Removes both generations of the log. Test cleanup, not used in the app. */
export function clearLogs(dir: string): void {
  rmSync(join(dir, LOG_NAME), { force: true });
  rmSync(join(dir, PREVIOUS_NAME), { force: true });
}
