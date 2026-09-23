import { clip, total } from "../state/spans.js";
import { earnedRows } from "./calendar.js";
import { addDays, dayKey, monthStart, weekStart } from "./days.js";
import { minedByStreamer, type InsightsDeps } from "./mined.js";

export type PeriodKind = "week" | "month";

export interface Totals {
  earned: number;
  /** Summed across channels, as adding up the cards would. */
  minedMs: number;
  /** Streams with any mined time in the period. */
  streams: number;
  /** Miner up as a share of the period so far, 0-100. */
  uptimePct: number;
}

export interface RecapChannel {
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  earned: number;
  minedMs: number;
}

export interface Recap {
  period: { kind: PeriodKind; from: number; to: number; partial: boolean };
  totals: Totals;
  previous: Totals | null;
  top: RecapChannel[];
  mostWatched: RecapChannel | null;
  highlights: {
    bestDay: { date: string; earned: number } | null;
    longestStreak: number;
    bonusClaims: number;
    raids: number;
    dropsClaimed: number;
    watchStreakBonuses: number;
  };
}

const EVENT_TYPES = ["BONUS_CLAIM", "JOIN_RAID", "DROP_CLAIM", "GAIN_FOR_WATCH_STREAK"] as const;

function bounds(kind: PeriodKind, now: number, offset: number): { from: number; end: number } {
  return kind === "week"
    ? { from: weekStart(now, offset), end: weekStart(now, offset + 1) }
    : { from: monthStart(now, offset), end: monthStart(now, offset + 1) };
}

interface Summary {
  totals: Totals;
  channels: Map<string, { earned: number; minedMs: number }>;
  perDay: Map<string, number>;
  hasData: boolean;
}

/** Everything about `[from, to)` that the recap reports. */
function summarise(deps: InsightsDeps, from: number, to: number, now: number): Summary {
  const firstDay = dayKey(from);
  const lastDay = dayKey(to - 1);
  const rows = earnedRows(deps, firstDay, now).filter((r) => r.day <= lastDay);

  const channels = new Map<string, { earned: number; minedMs: number }>();
  const perDay = new Map<string, number>();
  for (const row of rows) {
    const entry = channels.get(row.streamer) ?? { earned: 0, minedMs: 0 };
    entry.earned += row.earned;
    channels.set(row.streamer, entry);
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.earned);
  }

  let minedMs = 0;
  let streams = 0;
  for (const [login, mined] of minedByStreamer(deps, from, to)) {
    const ms = total(mined.spans);
    const entry = channels.get(login) ?? { earned: 0, minedMs: 0 };
    entry.minedMs += ms;
    channels.set(login, entry);
    minedMs += ms;
    streams += mined.streams;
  }

  const up = total(clip(deps.history.minerSpans(from), from, to));
  return {
    totals: {
      earned: rows.reduce((sum, r) => sum + r.earned, 0),
      minedMs,
      streams,
      uptimePct: Math.round((up / (to - from)) * 100),
    },
    channels,
    perDay,
    hasData: rows.length > 0 || up > 0,
  };
}

/**
 * A week or month in figures: totals against the period before, the top
 * channels, and highlights. `offset` 0 is the current period, which runs
 * only to now and is marked partial.
 */
export function buildRecap(deps: InsightsDeps, now: number, kind: PeriodKind, offset: number): Recap {
  const { from, end } = bounds(kind, now, offset);
  const to = Math.min(end, now);
  const current = summarise(deps, from, to, now);
  const before = bounds(kind, now, offset - 1);
  const previous = summarise(deps, before.from, before.end, now);

  const profiles = deps.streamers?.get([...current.channels.keys()]) ?? new Map();
  const channel = (login: string): RecapChannel => {
    const figures = current.channels.get(login)!;
    const profile = profiles.get(login);
    return {
      login,
      displayName: profile?.displayName ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      earned: figures.earned,
      minedMs: figures.minedMs,
    };
  };

  const logins = [...current.channels.keys()];
  const top = logins
    .filter((login) => current.channels.get(login)!.earned > 0)
    .sort((a, b) => current.channels.get(b)!.earned - current.channels.get(a)!.earned)
    .slice(0, 3)
    .map(channel);
  const watched = logins
    .filter((login) => current.channels.get(login)!.minedMs > 0)
    .sort((a, b) => current.channels.get(b)!.minedMs - current.channels.get(a)!.minedMs)[0];
  const mostWatched = watched === undefined || top.some((c) => c.login === watched)
    ? null
    : channel(watched);

  let bestDay: { date: string; earned: number } | null = null;
  let longestStreak = 0;
  let run = 0;
  for (let day = dayKey(from); day <= dayKey(to - 1); day = addDays(day, 1)) {
    const earned = current.perDay.get(day) ?? 0;
    if (earned > 0 && (bestDay === null || earned > bestDay.earned)) bestDay = { date: day, earned };
    run = earned > 0 ? run + 1 : 0;
    longestStreak = Math.max(longestStreak, run);
  }
  const events = deps.history.countEvents(EVENT_TYPES, from, to);

  return {
    period: { kind, from, to, partial: end > now },
    totals: current.totals,
    previous: previous.hasData ? previous.totals : null,
    top,
    mostWatched,
    highlights: {
      bestDay,
      longestStreak,
      bonusClaims: events.BONUS_CLAIM,
      raids: events.JOIN_RAID,
      dropsClaimed: events.DROP_CLAIM,
      watchStreakBonuses: events.GAIN_FOR_WATCH_STREAK,
    },
  };
}
