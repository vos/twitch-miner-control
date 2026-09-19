/** The levels pino writes, ordered least to most severe. */
export const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export type AppLevel = (typeof LEVELS)[number];

/** The minimum-severity filters the view offers. */
export const THRESHOLDS = ["all", "info", "warn", "error"] as const;

export type Threshold = (typeof THRESHOLDS)[number];

const RANK = new Map<string, number>(LEVELS.map((l, i) => [l, i]));

/**
 * Whether an event is at least as severe as the chosen threshold.
 *
 * A minimum rather than a set, because that is how a log is actually
 * read: "show me warnings and worse" is a question people ask, "show me
 * warnings but not errors" is not.
 *
 * An unrecognised level always shows. A new pino level, or a line
 * written by a future build, must not be silently filtered out of the
 * one view meant to explain what happened.
 */
export function atLeast(level: string, threshold: Threshold): boolean {
  if (threshold === "all") return true;
  const rank = RANK.get(level);
  if (rank === undefined) return true;
  return rank >= (RANK.get(threshold) ?? 0);
}

/**
 * The colour class for a level, reusing the miner log's palette.
 *
 * Shared on purpose: the two tabs sit beside each other, and a warning
 * that is amber in one and red in the other would read as two different
 * apps. `fatal` folds into error -- it is not a distinction this app's
 * events draw, and inventing a sixth colour for a level nothing emits
 * would be noise.
 */
export function classOf(level: string): "error" | "warn" | "info" | "debug" {
  if (level === "error" || level === "fatal") return "error";
  if (level === "warn") return "warn";
  if (level === "debug" || level === "trace") return "debug";
  return "info";
}
