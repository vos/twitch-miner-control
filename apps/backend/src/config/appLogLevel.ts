/** App event log level used when APP_LOG_LEVEL is unset. */
export const APP_LOG_LEVEL = "info";

/** Bytes the app event log grows to before it rotates, when unset. */
export const APP_LOG_MAX_BYTES = 5_242_880;

/**
 * Floor for APP_LOG_MAX_BYTES.
 *
 * A cap below this rotates so often that the two files it keeps cannot
 * hold even a single session's events, which defeats the point of having
 * a durable log at all. Values under it clamp rather than being rejected,
 * matching how resolveRetentionDays treats a sub-day retention.
 */
export const APP_LOG_MIN_BYTES = 65_536;

/**
 * The levels pino accepts, plus the one that turns logging off.
 *
 * `silent` is pino's own name for "log nothing" and is what the aliases
 * below resolve to; it is not a threshold like the others, which is why
 * it sits at the end rather than in level order.
 */
const LEVELS = [
  "trace", "debug", "info", "warn", "error", "fatal", "silent",
] as const;

/**
 * Names for "off" that someone would plausibly write in .env.
 *
 * `silent` is pino's term and is not what most people reach for when they
 * want a long-running production box to stop writing a log file, so the
 * obvious words are honoured rather than silently falling back to info --
 * which would be the worst outcome, since the operator asked for *less*
 * logging and would get the default amount.
 */
const OFF = new Set(["off", "none", "disabled", "no", "false"]);

/**
 * Resolves APP_LOG_LEVEL to the level the app event log writes at.
 *
 * Deliberately a separate variable from MINER_LOG_LEVEL, which sets the
 * *python miner's* file level (see logLevel.ts). The two logs have
 * different owners, formats and destinations, and one knob covering both
 * would mean turning off the app's own decision record just to quieten
 * the miner's keepalive chatter, or the reverse.
 *
 * An unrecognised value falls back to the default rather than throwing,
 * for the same reason resolveMinerLogLevel does: this is read at boot in
 * the composition root, and a throw would turn a typo in .env into a
 * backend that will not start, reported as a stack trace with no mention
 * of the variable at fault.
 */
export function resolveAppLogLevel(value: string | undefined): string {
  // `APP_LOG_LEVEL=` in .env reads as unset, matching the other resolvers.
  if (value === undefined || value.trim() === "") return APP_LOG_LEVEL;
  const normalized = value.trim().toLowerCase();
  if (OFF.has(normalized)) return "silent";
  // WARNING is Python's spelling, and the miner's level variable next door
  // uses it -- cheap to honour rather than falling back to info for what is
  // obviously a level name.
  const level = normalized === "warning" ? "warn" : normalized;
  return (LEVELS as readonly string[]).includes(level) ? level : APP_LOG_LEVEL;
}

/**
 * Resolves APP_LOG_MAX_BYTES to the size the log rotates at.
 *
 * Bounds disk rather than time: two files are kept, so the log costs at
 * most twice this. A day-count would not bound anything here, because
 * this log's volume is driven by how much the app decides rather than by
 * a clock -- an idle week and a crash-looping hour can produce the same
 * number of lines.
 *
 * Zero is NOT special-cased into "never rotate": an unbounded log file on
 * a long-running box is precisely the failure this app already hit once
 * with the miner's own log (see logLevel.ts, 267MB in a day). It clamps
 * to the floor like any other too-small value.
 */
export function resolveAppLogMaxBytes(value: string | undefined): number {
  // `Number("")` is 0, not NaN, so a bare `APP_LOG_MAX_BYTES=` would
  // otherwise clamp to the floor instead of reading as unset.
  if (value === undefined || value.trim() === "") return APP_LOG_MAX_BYTES;
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return APP_LOG_MAX_BYTES;
  return Math.max(APP_LOG_MIN_BYTES, Math.floor(bytes));
}
