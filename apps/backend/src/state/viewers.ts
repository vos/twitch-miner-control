/**
 * Below this, a viewer count is reported exactly.
 *
 * Three significant figures only starts rounding at four digits, so this
 * is really documentation of that: a channel with 47 or 892 viewers
 * reports the true number, because at that size the card prints the
 * figure as-is and any rounding would be visible.
 */
export const EXACT_BELOW = 1000;

/**
 * A viewer count damped to three significant figures.
 *
 * The snapshot's change detection is a whole-object JSON comparison
 * (see StateService.refresh), so any field that moves every poll pushes
 * a frame to every connected browser every minute whether or not
 * anything meaningful changed. A viewer count is exactly that field:
 * it drifts constantly and is never read to the person.
 *
 * Three significant figures is chosen against how the figure is
 * rendered -- 18,432 shows as "18.4K" -- so the rounding is invisible on
 * the card while small drifts collapse to the same number and stop
 * waking clients. Counts below a thousand are printed in full and so
 * are left exact.
 */
export function roundViewers(count: number | null): number | null {
  if (count === null || count < EXACT_BELOW) return count;
  const magnitude = 10 ** (Math.floor(Math.log10(count)) - 2);
  return Math.round(count / magnitude) * magnitude;
}
