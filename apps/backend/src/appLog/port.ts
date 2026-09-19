/**
 * One thing the app decided, and the evidence behind it.
 *
 * `type` is the taxonomy key (see types.ts) and is what a reader filters
 * and scans on. `msg` is a human sentence that already contains the
 * reason, so a line is legible without knowing the field names. Anything
 * else is the evidence: the numbers and names that let a reader check the
 * decision rather than take it on trust.
 */
export interface AppEvent {
  type: string;
  msg: string;
  [field: string]: unknown;
}

/**
 * Where app events go.
 *
 * Deliberately not pino's interface, though pino is what implements it in
 * production. Consumers of this port are the supervisor, the drops engine
 * and the HTTP layer -- all of which have tests that must assert on what
 * was decided without writing a file, starting a worker or pulling a
 * logging library into the test run. A five-method port makes that double
 * three lines (see memory.ts), and keeps the real implementation
 * swappable behind it.
 */
export interface AppLog {
  debug(event: AppEvent): void;
  info(event: AppEvent): void;
  warn(event: AppEvent): void;
  error(event: AppEvent): void;
  /** A view that stamps `component` onto everything logged through it. */
  child(bindings: { component: string }): AppLog;
}

/**
 * An AppLog that discards everything.
 *
 * Every consumer takes its logger optionally and falls back to this, so a
 * test that does not care about logging constructs nothing extra and a
 * call site never needs `?.`. Logging is diagnostic: a module must behave
 * identically whether or not anyone is listening, and the cleanest way to
 * guarantee that is for "nobody listening" to be an ordinary AppLog
 * rather than an absent one.
 */
export const NULL_LOG: AppLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => NULL_LOG,
};
