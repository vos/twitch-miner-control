import type { GameActivity } from "./campaignCatalogue.js";

const DAY_MS = 86_400_000;

/** Distinct start days needed before a rhythm is claimed. */
const MIN_STARTS = 5;

/** Gaps read, newest first: the recent rhythm, not the game's lifetime. */
const RECENT_GAPS = 12;

/** How a game runs drops, as the followed games card says it. */
export interface DropRhythm {
  /** When its most recent finished campaign ended; null if none known. */
  lastEndedAt: number | null;
  /**
   * Its usual days between campaigns, or null when there is no rhythm
   * to report: too little history, gaps too uneven to call one, or a
   * game quiet for far longer than its usual gap.
   */
  everyDays: number | null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * A game's drop rhythm, from the tracker's history plus what runs now.
 *
 * Campaigns opening the same day count once: the parts of one event open
 * together, and read separately they make a weekly game look like it
 * runs every few days. The rhythm is the median gap, claimed only when
 * two thirds of the recent gaps sit within half to double of it -- a
 * made-up schedule promises a campaign that may be months away, which is
 * worse than saying nothing.
 */
export function dropRhythm(
  activity: GameActivity | undefined,
  current: readonly { startsAt: number | null }[],
  now: number,
): DropRhythm {
  const lastEndedAt = activity?.lastEndedAt ?? null;
  if (activity?.past === undefined) return { lastEndedAt, everyDays: null };

  const days = [...new Set([
    ...activity.past.map((w) => w.startsAt),
    ...current.flatMap((c) => (c.startsAt === null ? [] : [c.startsAt])),
  ].map((at) => Math.floor(at / DAY_MS)))].sort((a, b) => a - b);
  if (days.length < MIN_STARTS) return { lastEndedAt, everyDays: null };

  const recent = days.slice(-(RECENT_GAPS + 1));
  const gaps = recent.slice(1).map((day, i) => day - recent[i]!);
  const usual = Math.max(1, median(gaps));
  const typical = gaps.filter((g) => g >= usual / 2 && g <= usual * 2).length;
  if (typical * 3 < gaps.length * 2) return { lastEndedAt, everyDays: null };

  // Quiet for more than three of its usual gaps: whatever the rhythm
  // was, it is not the one to expect now.
  const opened = days.filter((day) => day * DAY_MS <= now);
  const lastStart = opened.at(-1);
  if (lastStart === undefined || now - lastStart * DAY_MS > usual * 3 * DAY_MS) {
    return { lastEndedAt, everyDays: null };
  }
  return { lastEndedAt, everyDays: Math.round(usual) };
}
