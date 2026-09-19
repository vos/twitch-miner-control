import type { RecordedEvent } from "./memory.js";

/**
 * One app event as it reaches a reader: the logged fields, plus the
 * envelope pino stamped on.
 *
 * `time` is epoch ms rather than a formatted string, because the UI
 * renders it in the viewer's own timezone and a pre-formatted one would
 * bake the server's in.
 */
export interface AppLogEvent extends Omit<RecordedEvent, "level"> {
  level: string;
  time: number;
}

/**
 * How many events the buffer holds.
 *
 * Far smaller than the miner's 2000-line buffer because these are
 * decisions rather than output: a healthy day produces tens, and a
 * pathological one -- a crash loop with a subscription flapping -- a few
 * hundred. 500 covers both while staying cheap to serialise in one
 * response. The file behind it keeps the full history regardless, so this
 * bound costs reach in the UI, not data.
 */
export const APP_LOG_CAPACITY = 500;

/**
 * Ring of recent app events, for the UI to read.
 *
 * Mirrors miner/logBuffer.ts deliberately, including the `total`
 * contract: the frontend's gap detection is written against that shape
 * and generalises to this one unchanged, rather than needing a second,
 * subtly different implementation of the trickiest logic in the app.
 */
export class AppLogBuffer {
  private events: AppLogEvent[] = [];
  private kept = 0;

  constructor(private readonly capacity = APP_LOG_CAPACITY) {}

  /**
   * Every event ever kept, including those since evicted. A reader that
   * knows the total its copy ends at can tell which pushed events it
   * already has -- and, crucially, whether any went by unseen.
   */
  get total(): number {
    return this.kept;
  }

  push(event: AppLogEvent): AppLogEvent {
    this.events.push(event);
    this.kept += 1;
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    return event;
  }

  /**
   * Seeds the ring with events read back from the file at boot.
   *
   * Separate from push() because these are not new: `total` counts them
   * as the history they are, so the first frame a client receives after
   * connecting does not look like a gap.
   */
  seed(events: readonly AppLogEvent[]): void {
    for (const event of events) this.push(event);
  }

  entries(): AppLogEvent[] {
    return [...this.events];
  }
}
