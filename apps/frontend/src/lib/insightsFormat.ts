import type { CalendarDay, RecapPayload } from "../api/useInsights.js";
import { localDayKey, mondayOf, parseDayKey } from "./days.js";
import { HEAT_EMPTY, HEAT_STEPS } from "./heatRamp.js";

const nf = new Intl.NumberFormat("en-US");
const WEEK_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * The upper bounds of the first three colour steps: quartiles of the
 * user's own non-zero days. Relative rather than fixed, so a big roster
 * does not paint every day at full strength and a small one is not left
 * pale all year.
 */
export function quantileSteps(values: number[]): number[] {
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length < 2) return [];
  const at = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
  return [at(0.25), at(0.5), at(0.75)];
}

/** A day's colour: empty for zero, else its quartile's step. */
export function stepColor(value: number, thresholds: number[]): string {
  if (value <= 0) return HEAT_EMPTY;
  const step = thresholds.findIndex((t) => value <= t);
  return HEAT_STEPS[step === -1 ? HEAT_STEPS.length - 1 : step];
}

/** How many weeks before this one the week containing `date` is (0 or less). */
export function weekOffsetOf(date: string, now: number): number {
  // Rounded: a DST change makes the gap between two Mondays an hour off.
  return Math.round((mondayOf(parseDayKey(date).getTime()) - mondayOf(now)) / WEEK_MS);
}

/** "6h 12m", "45m", "31h". */
export function formatHoursMinutes(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * "Tue 15 Sep", assembled from en-US parts: en-GB's short month for
 * September is "Sept" in current ICU data, and "Sep" in older builds.
 */
export function shortDate(key: string): string {
  const d = parseDayKey(key);
  const weekday = d.toLocaleDateString("en-US", { weekday: "short" });
  const month = d.toLocaleDateString("en-US", { month: "short" });
  return `${weekday} ${d.getDate()} ${month}`;
}

/** "Tue 15 Sep · 8,420 earned · 6h 12m mined · top: AlphaTV". */
export function describeDay(day: CalendarDay, since: string | null): string {
  const date = shortDate(day.date);
  if (since === null || day.date < since) return `${date} · before tracking began`;
  if (day.earned === 0 && day.minedMs === 0) return `${date} · nothing earned`;
  const parts = [date, `${nf.format(day.earned)} earned`];
  if (day.minedMs > 0) parts.push(`${formatHoursMinutes(day.minedMs)} mined`);
  if (day.top !== null) parts.push(`top: ${day.top.displayName ?? day.top.login}`);
  return parts.join(" · ");
}

const month = (d: Date, style: "short" | "long") =>
  d.toLocaleString("en-US", { month: style }).toUpperCase();

/** "WEEK OF SEP 14–20 · 2026 · SO FAR", "AUGUST 2026". */
export function periodLabel(period: RecapPayload["period"]): string {
  const start = new Date(period.from);
  let label: string;
  if (period.kind === "month") {
    label = `${month(start, "long")} ${start.getFullYear()}`;
  } else {
    const last = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    const tail = last.getMonth() === start.getMonth()
      ? `${last.getDate()}`
      : `${month(last, "short")} ${last.getDate()}`;
    label = `WEEK OF ${month(start, "short")} ${start.getDate()}–${tail} · ${start.getFullYear()}`;
  }
  return period.partial ? `${label} · SO FAR` : label;
}

/** "▲ 12%", "▼ 3h", "▼ 2 pts", "no change" -- or null with nothing to compare. */
export function changeLabel(
  kind: "earned" | "mined" | "uptime",
  now: number,
  prev: number,
): string | null {
  let amount: number;
  let unit: string;
  if (kind === "earned") {
    if (prev <= 0) return null;
    amount = Math.round(((now - prev) / prev) * 100);
    unit = "%";
  } else if (kind === "mined") {
    amount = Math.round((now - prev) / HOUR_MS);
    unit = "h";
  } else {
    amount = now - prev;
    unit = " pts";
  }
  if (amount === 0) return "no change";
  return `${amount > 0 ? "▲" : "▼"} ${Math.abs(amount)}${unit}`;
}

/** "twitch-miner-week-2026-09-14.png", "twitch-miner-month-2026-09.png". */
export function recapFilename(period: RecapPayload["period"]): string {
  const day = localDayKey(period.from);
  return `twitch-miner-${period.kind}-${period.kind === "week" ? day : day.slice(0, 7)}.png`;
}
