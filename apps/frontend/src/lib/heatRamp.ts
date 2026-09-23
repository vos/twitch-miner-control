/**
 * The heatmaps' shared colour scale: one hue, faint to bright.
 *
 * Checked with the dataviz skill's ordinal validator against the dark
 * dialog surface (#18181B): lightness rises monotonically with visible
 * gaps between steps, the faintest step clears 2:1 against the surface,
 * and the hue spread is 4°. Re-run it before changing a value.
 */
export const HEAT_STEPS = ["#5E37A0", "#7A40D5", "#9A5BFF", "#C4A3FF"] as const;

/**
 * A cell with nothing in it: observed, and zero. Not a data step, so a
 * "never" cannot be mistaken for the faintest "sometimes".
 */
export const HEAT_EMPTY = "#26262C";

/** The colour for a 0..1 share, in four equal bands above zero. */
export function heatColor(fraction: number): string {
  if (fraction <= 0) return HEAT_EMPTY;
  const step = Math.min(HEAT_STEPS.length, Math.ceil(fraction * HEAT_STEPS.length)) - 1;
  return HEAT_STEPS[step];
}
