const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A duration of *work done*, rounded down.
 *
 * formatSpan is built for labelling a gain window, where "about an hour"
 * is the point, so it rounds to nearest and floors at "1m": 30 minutes
 * renders "1h" and zero renders "1m". Both are wrong for a mining
 * figure, which is a claim about time actually spent -- rounding up
 * overstates it by as much as 2x, and this figure exists precisely to
 * show when mining time is short or missing.
 *
 * So: truncate, and let a genuine zero read "0m".
 */
export function formatWorked(ms: number): string {
  if (ms < MINUTE) return "0m";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}
