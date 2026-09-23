/**
 * Local calendar days, the unit Insights counts in.
 *
 * Keys are 'YYYY-MM-DD' in the server's timezone. Every step goes through
 * the Date constructor rather than adding 86,400,000, so the days either
 * side of a DST change are the 23 and 25 hours they really are.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day a timestamp falls on. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight at the start of a day. */
export function dayStart(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** The day `n` days after (or before, for negative `n`) a day. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n).getTime());
}

/** Local midnight on the Monday of the ISO week `offset` weeks from now's. */
export function weekStart(now: number, offset: number): number {
  const d = new Date(now);
  const sinceMonday = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - sinceMonday + 7 * offset).getTime();
}

/** Local midnight on the first of the month `offset` months from now's. */
export function monthStart(now: number, offset: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime();
}

/** How much of the given spans falls on each local day. */
export function msByDay(spans: ReadonlyArray<{ start: number; end: number }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const span of spans) {
    let cursor = span.start;
    while (cursor < span.end) {
      const key = dayKey(cursor);
      const boundary = Math.min(span.end, dayStart(addDays(key, 1)));
      out.set(key, (out.get(key) ?? 0) + (boundary - cursor));
      cursor = boundary;
    }
  }
  return out;
}
