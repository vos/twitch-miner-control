const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Labels how much time a partial gain window actually covers.
 *
 * Deliberately coarse and single-unit: this sits beside a number as a
 * qualifier ("+120 · 3h"), not as a readout of its own, so "2h 47m" would
 * cost more attention than the caveat is worth.
 *
 * Rounds rather than truncates -- a window of 59 minutes is far better
 * described as "1h" than as "59m", and one of 3.9 hours as "4h". The
 * floor is "1m": a window shorter than that is still real, and rendering
 * "0m" would read as though no time had passed at all.
 */
export function formatSpan(ms: number): string {
  // The unit is chosen by the rounded *hour* count, not by the raw
  // duration: 59 minutes rounds to a full hour and should read "1h",
  // where testing `ms >= HOUR` would have printed "59m".
  const hours = Math.round(ms / HOUR);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.round(ms / MINUTE))}m`;
}
