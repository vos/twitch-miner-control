/**
 * A viewer count as the card prints it: "47", "1.2K", "248K", "1.2M".
 *
 * The backend rounds these to three significant figures before they are
 * sent (see roundViewers), so the abbreviation here never hides a
 * precision the snapshot actually carried -- 18,400 really is all that
 * is known, and "18.4K" says so in five characters instead of six.
 *
 * Null for an offline channel: a stream that is not running has no
 * audience, which is a different fact from an audience of zero.
 */
export function formatViewers(count: number | null): string | null {
  if (count === null) return null;
  if (count < 1000) return String(count);

  const [value, suffix] = count < 1_000_000
    ? [count / 1000, "K"]
    : [count / 1_000_000, "M"];
  // The tenth is kept even when it is a zero: "2K" would throw away
  // precision the snapshot carries, since 2,000 is exact at this
  // magnitude. Only at or above 100K has the upstream rounding to three
  // significant figures already dropped the tenth, leaving none to show.
  const shown = value >= 100 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown}${suffix}`;
}
