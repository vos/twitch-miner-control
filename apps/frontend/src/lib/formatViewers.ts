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
  // A trailing ".0" spends a character saying nothing -- the rounding
  // upstream guarantees the tenth is zero at this magnitude.
  const shown = value >= 100 || Number.isInteger(value)
    ? Math.round(value).toString()
    : value.toFixed(1);
  return `${shown}${suffix}`;
}
