import type { PointSample } from "../db/history.js";

/**
 * Reduces a change-only series to a fixed-length array of balances for a
 * sparkline.
 *
 * Buckets by *time*, not by row index. Snapshots are written only when the
 * balance changes, so rows are unevenly spaced: a claim burst can put five
 * rows in one minute while a quiet hour has none. Taking every Nth row
 * would stretch the burst across most of the line and collapse the quiet
 * hour to nothing -- the shape would misreport when the earning happened.
 *
 * Each bucket holds the last balance known at its end, so quiet buckets
 * render flat (the balance genuinely did not move) rather than as gaps.
 * Buckets before the first sample are back-filled with the earliest known
 * balance: we do not know the value then, and starting from zero would
 * draw a dramatic climb that never happened.
 */
export function downsample(
  samples: PointSample[],
  fromTs: number,
  toTs: number,
  buckets = 24,
): number[] {
  if (samples.length === 0) return [];

  const span = toTs - fromTs;
  const width = span / buckets;
  const out: number[] = [];
  let cursor = 0;
  let carried: number | null = null;

  for (let i = 0; i < buckets; i++) {
    const end = fromTs + width * (i + 1);
    while (cursor < samples.length && samples[cursor].ts <= end) {
      carried = samples[cursor].balance;
      cursor++;
    }
    out.push(carried ?? samples[0].balance);
  }
  return out;
}
