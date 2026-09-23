import type { DailyRow } from "../db/dailyPoints.js";
import { addDays, dayKey, dayStart, msByDay } from "./days.js";
import { minedByStreamer, type InsightsDeps } from "./mined.js";
import { earnedByStreamer, rollupDays } from "./rollup.js";

export interface CalendarDay {
  date: string;
  earned: number;
  minedMs: number;
  top: { login: string; displayName: string | null; earned: number } | null;
}

export interface Calendar {
  days: CalendarDay[];
  /** The first day with any record; days before it are no data, not zero. */
  since: string | null;
  streak: { current: number; longest: number };
}

/**
 * Points earned per streamer per day from `fromDay` through today: rolled
 * up days from the table, and today computed live.
 *
 * Rolls up first, so a day that ended since the last housekeeping pass is
 * here rather than missing until the timer next fires.
 */
export function earnedRows(deps: InsightsDeps, fromDay: string, now: number): DailyRow[] {
  rollupDays(deps, now);
  const today = dayKey(now);
  const rows = deps.daily.between(fromDay, addDays(today, -1));
  if (fromDay <= today) {
    for (const [streamer, earned] of earnedByStreamer(deps.history, dayStart(today), now + 1)) {
      rows.push({ day: today, streamer, earned });
    }
  }
  return rows;
}

/** The last `days` days, oldest first, ending today. */
export function buildCalendar(deps: InsightsDeps, now: number, days: number): Calendar {
  const today = dayKey(now);
  const from = addDays(today, -(days - 1));

  const perDay = new Map<string, { earned: number; top: { login: string; earned: number } | null }>();
  for (const row of earnedRows(deps, from, now)) {
    const entry = perDay.get(row.day) ?? { earned: 0, top: null };
    entry.earned += row.earned;
    if (row.earned > 0 && (entry.top === null || row.earned > entry.top.earned)) {
      entry.top = { login: row.streamer, earned: row.earned };
    }
    perDay.set(row.day, entry);
  }

  const mined = msByDay(
    [...minedByStreamer(deps, dayStart(from), now).values()]
      .flatMap((m) => m.spans)
      .map((s) => ({ start: s.start, end: s.end ?? s.start })),
  );

  const logins = [...perDay.values()].flatMap((e) => (e.top === null ? [] : [e.top.login]));
  const names = deps.streamers?.get([...new Set(logins)]) ?? new Map();

  const out: CalendarDay[] = [];
  for (let date = from; date <= today; date = addDays(date, 1)) {
    const entry = perDay.get(date);
    const top = entry?.top ?? null;
    out.push({
      date,
      earned: entry?.earned ?? 0,
      minedMs: mined.get(date) ?? 0,
      top: top === null
        ? null
        : { ...top, displayName: names.get(top.login)?.displayName ?? null },
    });
  }

  return {
    days: out,
    since: deps.daily.firstDay() ?? (perDay.has(today) ? today : null),
    streak: streaks(out, today),
  };
}

/**
 * Runs of days with points earned.
 *
 * `current` counts back from today once today has earned, and from
 * yesterday until then -- otherwise every streak would read 0 each
 * morning until the first points of the day land.
 */
function streaks(days: CalendarDay[], today: string): { current: number; longest: number } {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.earned > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const earnedOn = new Map(days.map((d) => [d.date, d.earned]));
  let cursor = (earnedOn.get(today) ?? 0) > 0 ? today : addDays(today, -1);
  let current = 0;
  while ((earnedOn.get(cursor) ?? 0) > 0) {
    current += 1;
    cursor = addDays(cursor, -1);
  }
  return { current, longest };
}
