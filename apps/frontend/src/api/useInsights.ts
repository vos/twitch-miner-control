import { useEffect, useState } from "react";
import { api } from "./client.js";

export type PeriodKind = "week" | "month";

export interface CalendarDay {
  date: string;
  earned: number;
  minedMs: number;
  top: { login: string; displayName: string | null; earned: number } | null;
}

export interface CalendarPayload {
  days: CalendarDay[];
  since: string | null;
  streak: { current: number; longest: number };
}

export interface Totals {
  earned: number;
  minedMs: number;
  streams: number;
  uptimePct: number;
}

export interface RecapChannel {
  login: string;
  displayName: string | null;
  avatarUrl: string | null;
  earned: number;
  minedMs: number;
}

export interface RecapPayload {
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

/**
 * A JSON resource that is checked before it is trusted, and kept on
 * screen while its replacement loads -- stepping between periods swaps
 * the card rather than blanking it.
 */
function useChecked<T>(url: string, valid: (body: unknown) => body is T) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get<unknown>(url)
      .then((body) => {
        if (!live) return;
        if (!valid(body)) throw new Error("malformed response");
        setData(body);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "failed to load");
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // `valid` is a module-level guard; only the URL decides a refetch.
  }, [url]);
  return { data, error, loading };
}

const isCalendar = (body: unknown): body is CalendarPayload =>
  Array.isArray((body as CalendarPayload | null)?.days);
const isRecap = (body: unknown): body is RecapPayload =>
  typeof (body as RecapPayload | null)?.totals?.earned === "number";

export function useCalendar() {
  const { data, error } = useChecked("/api/insights/calendar?days=365", isCalendar);
  return { data, error };
}

export function useRecap(kind: PeriodKind, offset: number) {
  return useChecked(`/api/insights/recap?period=${kind}&offset=${offset}`, isRecap);
}
