/** File log level used when MINER_LOG_LEVEL is unset. */
export const MINER_LOG_LEVEL = "INFO";

/**
 * The levels the miner's file handler accepts, as Python `logging`
 * names. Kept as names rather than numbers because this value is handed
 * to `python/run.py`, which maps it with `logging.getLevelName()` -- a
 * number here would still work but reads as a magic constant in .env.
 */
const LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] as const;

/**
 * Resolves MINER_LOG_LEVEL to the level the miner writes to its log file.
 *
 * Upstream defaults `LoggerSettings.file_level` to DEBUG (logger.py:99)
 * while this app sets `console_level` to INFO, so the file recorded every
 * websocket keepalive, StreamerSelector pass and urllib3 connection the
 * miner made -- 99.7% of a measured sample was DEBUG, and a single day's
 * file reached 267MB. Upstream's TimedRotatingFileHandler caps that at
 * seven days (backupCount=7), so it is bounded rather than unbounded, but
 * the bound was still ~1.9GB of mostly keepalives. INFO keeps every line
 * the Logs page shows plus all warnings and errors, at roughly 1/300th
 * the size.
 *
 * DEBUG remains available for diagnosing a specific failure: upstream's
 * connection and GQL tracing is genuinely useful when the miner misbehaves,
 * it is just not something to write continuously.
 *
 * An unrecognised value falls back to the default rather than throwing.
 * The miner is spawned by the supervisor and a throw here would surface as
 * a crash-looping miner with a stack trace, which is a poor way to report
 * a typo in .env -- the app should keep mining at a sane level instead.
 */
export function resolveMinerLogLevel(value: string | undefined): string {
  // `MINER_LOG_LEVEL=` in .env reads as unset, matching the other resolvers.
  if (value === undefined || value.trim() === "") return MINER_LOG_LEVEL;
  const normalized = value.trim().toUpperCase();
  // WARN is what most other logging ecosystems call this level, and
  // Python's own getLevelName() does not accept it. Cheap to honour.
  const level = normalized === "WARN" ? "WARNING" : normalized;
  return (LEVELS as readonly string[]).includes(level) ? level : MINER_LOG_LEVEL;
}
