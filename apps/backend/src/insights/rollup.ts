import type { DailyPoints } from "../db/dailyPoints.js";
import type { History } from "../db/history.js";
import { addDays, dayKey, dayStart } from "./days.js";
import { earnedFor } from "./earned.js";

export interface RollupDeps {
  history: History;
  daily: DailyPoints;
}

/** Each streamer's points earned in `[fromTs, toTs)`, for streamers with a snapshot in it. */
export function earnedByStreamer(history: History, fromTs: number, toTs: number): Map<string, number> {
  const balances = new Map<string, number[]>();
  for (const sample of history.samplesBetween(fromTs, toTs)) {
    const list = balances.get(sample.streamer) ?? [];
    list.push(sample.balance);
    balances.set(sample.streamer, list);
  }
  const out = new Map<string, number>();
  for (const [streamer, list] of balances) {
    out.set(streamer, earnedFor(history.balanceBefore(streamer, fromTs), list));
  }
  return out;
}

/**
 * Writes every complete local day that has snapshots and no rows yet.
 *
 * Run before every prune, so a day is summarised before its snapshots can
 * be deleted, and on each Insights request, so a day that ended since the
 * last pass is there without waiting a day for the timer. Days already
 * written are skipped, never recomputed. Today is never written: it is
 * not over.
 */
export function rollupDays({ history, daily }: RollupDeps, now: number): number {
  const earliest = history.earliestSampleTs();
  if (earliest === null) return 0;
  const today = dayKey(now);
  let written = 0;
  for (let day = dayKey(earliest); day < today; day = addDays(day, 1)) {
    if (daily.has(day)) continue;
    const earned = earnedByStreamer(history, dayStart(day), dayStart(addDays(day, 1)));
    if (earned.size === 0) continue;
    daily.write(day, earned);
    written += 1;
  }
  return written;
}
