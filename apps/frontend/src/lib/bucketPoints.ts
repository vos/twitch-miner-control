import type { RangeKey } from "./detailRanges.js";

export interface PointSample {
  ts: number;
  balance: number;
}

export interface ChartRow {
  /** Start of the bucket: a whole local hour, or local midnight. */
  ts: number;
  /** The balance in force at the end of this bucket. */
  balance: number;
  /** What the balance moved within the bucket. */
  gain: number;
}

const HOUR = 3_600_000;

/**
 * Bucket width per range: an hour for 24h, a calendar day for the rest.
 *
 * Buckets sit on the clock -- whole local hours, local midnights -- not
 * on whenever the first sample happened to land. Offset buckets labelled
 * "13:27", "14:27" read as noise, and a "day" running 13:27 to 13:27
 * splits every evening's stream across two bars.
 */
const UNIT: Record<RangeKey, "hour" | "day"> = {
  "24h": "hour",
  "7d": "day",
  "30d": "day",
  all: "day",
};

/** The start of the bucket holding `ts`. Local, like every label. */
function floorTo(ts: number, unit: "hour" | "day"): number {
  const d = new Date(ts);
  if (unit === "day") d.setHours(0, 0, 0, 0);
  else d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** The next bucket's start. A day is stepped on the calendar rather than
 *  by a fixed width: a DST boundary makes a local day 23 or 25 hours
 *  long. An hour is always an hour, even the one a DST change repeats. */
function next(edge: number, unit: "hour" | "day"): number {
  if (unit === "hour") return edge + HOUR;
  const d = new Date(edge);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Turns change-only balance snapshots into clock-aligned chart rows.
 *
 * The central rule: a gap between samples is a FLAT balance, not a
 * gradual climb. recordPoints writes only when the balance moves, so a
 * quiet week is two rows in the table; drawing a line between them would
 * claim steady earning across days when nothing happened. Each bucket
 * therefore carries the last balance at or before its close, and a
 * bucket with no sample repeats the one before it with a zero gain --
 * all the way to `to`, so a channel quiet since this morning still draws
 * the afternoon.
 *
 * `gain` is what the balance moved within the bucket: its closing
 * balance less the previous bucket's. The first bucket has no previous
 * one, so it measures from its own first sample -- the balance before
 * the window is not in the series, and treating the opening balance as
 * earnings would invent an enormous gain.
 */
export function bucketPoints(
  series: PointSample[],
  key: RangeKey,
  from: number,
  to: number,
): ChartRow[] {
  const inWindow = series.filter((s) => s.ts >= from && s.ts <= to);
  if (inWindow.length === 0) return [];

  const unit = UNIT[key];
  const rows: ChartRow[] = [];
  let index = 0;
  let previous = inWindow[0].balance;

  for (let edge = floorTo(inWindow[0].ts, unit); edge <= to; edge = next(edge, unit)) {
    const bound = next(edge, unit);
    // Every sample landing in this bucket; the last one wins, since the
    // bucket reports the balance in force when it closed.
    let balance = previous;
    while (index < inWindow.length && inWindow[index].ts < bound) {
      balance = inWindow[index].balance;
      index += 1;
    }
    rows.push({ ts: edge, balance, gain: balance - previous });
    previous = balance;
  }
  return rows;
}
