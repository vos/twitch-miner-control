import type { RangeKey } from "./detailRanges.js";

export interface PointSample {
  ts: number;
  balance: number;
}

export interface ChartRow {
  ts: number;
  /** The balance in force at the end of this bucket. */
  balance: number;
  /** Change from the previous bucket. Zero for the first row. */
  gain: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Bucket width per range, chosen so a chart holds 24-60 points. */
const BUCKET: Record<RangeKey, number> = {
  "24h": HOUR,
  "7d": 6 * HOUR,
  "30d": 24 * HOUR,
  all: 24 * HOUR,
};

/**
 * Turns change-only balance snapshots into evenly spaced chart rows.
 *
 * The central rule: a gap between samples is a FLAT balance, not a
 * gradual climb. recordPoints writes only when the balance moves, so a
 * quiet week is two rows in the table; drawing a line between them would
 * claim steady earning across days when nothing happened. Each bucket
 * therefore carries the last balance at or before it, and a bucket with
 * no sample repeats the one before it with a zero gain.
 *
 * `gain` is the first difference of that series, which is the figure
 * worth looking at: a cumulative balance is nearly flat at most zooms.
 * The first row's gain is 0 rather than its balance -- there is no
 * earlier bucket to difference against, and treating the opening balance
 * as earnings would invent an enormous one.
 */
export function bucketPoints(
  series: PointSample[],
  key: RangeKey,
  from: number,
  to: number,
): ChartRow[] {
  const inWindow = series.filter((s) => s.ts >= from && s.ts <= to);
  if (inWindow.length === 0) return [];

  const width = BUCKET[key];
  const start = inWindow[0].ts;
  const rows: ChartRow[] = [];
  let index = 0;
  let balance = inWindow[0].balance;
  let previous: number | null = null;

  for (let edge = start; edge <= to; edge += width) {
    const bound = edge + width;
    // Every sample landing in this bucket; the last one wins, since the
    // bucket reports the balance in force when it closed.
    while (index < inWindow.length && inWindow[index].ts < bound) {
      balance = inWindow[index].balance;
      index += 1;
    }
    const ts = index >= inWindow.length ? Math.min(bound - width, to) : edge;
    rows.push({ ts, balance, gain: previous === null ? 0 : balance - previous });
    previous = balance;
    if (index >= inWindow.length) break;
  }

  // The final sample may land past the last bucket edge; it is the most
  // recent truth and must not be dropped off the right of the chart.
  const last = inWindow[inWindow.length - 1];
  const tail = rows[rows.length - 1];
  if (tail.balance !== last.balance) {
    rows.push({ ts: last.ts, balance: last.balance, gain: last.balance - tail.balance });
  }
  return rows;
}
