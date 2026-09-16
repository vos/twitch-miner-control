export interface Span {
  start: number;
  /** Null while still running; resolved against `now` when read. */
  end: number | null;
}

/** A stretch of one day, as fractions of that day's width. */
export interface Band {
  startFraction: number;
  endFraction: number;
}

export interface CoverageDay {
  /** Local midnight opening this day. */
  dayStart: number;
  live: Band[];
  mined: Band[];
  liveMs: number;
  minedMs: number;
}

/** Local midnight `offset` calendar days from the one at or before `ts`.
 *  Local, not UTC: the rows are labelled with dates a person reads off
 *  their own calendar. Stepped with setDate rather than a fixed 24h: a DST
 *  boundary makes a local day 23 or 25 hours long, and a constant step
 *  lands an hour off midnight -- on the wrong day, for a 23-hour one. */
function midnight(ts: number, offset = 0): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
}

/** The portion of `span` falling inside one day, as fractions of it. */
function bandsFor(spans: Span[], dayStart: number, now: number): {
  bands: Band[];
  ms: number;
} {
  const dayEnd = midnight(dayStart, 1);
  const width = dayEnd - dayStart;
  const bands: Band[] = [];
  let ms = 0;
  for (const span of spans) {
    const start = Math.max(span.start, dayStart);
    // An open span ends at now, never at the day's end: a day in the past
    // with a still-open span must not report a full 24 hours.
    const end = Math.min(span.end ?? now, dayEnd, now);
    if (end <= start) continue;
    ms += end - start;
    bands.push({
      startFraction: (start - dayStart) / width,
      endFraction: (end - dayStart) / width,
    });
  }
  return { bands, ms };
}

/**
 * Splits live and mined spans into per-day bands for the coverage strip.
 *
 * A stream crossing midnight is split, appearing on both days -- the
 * strip is a calendar, so a span has to be cut at the boundary rather
 * than assigned to whichever day it started in.
 *
 * Returned oldest first, so the rows read downward like a calendar.
 */
export function coverageRows(
  live: Span[],
  mined: Span[],
  days: number,
  now: number,
): CoverageDay[] {
  const rows: CoverageDay[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dayStart = midnight(now, -i);
    const liveDay = bandsFor(live, dayStart, now);
    const minedDay = bandsFor(mined, dayStart, now);
    rows.push({
      dayStart,
      live: liveDay.bands,
      mined: minedDay.bands,
      liveMs: liveDay.ms,
      minedMs: minedDay.ms,
    });
  }
  return rows;
}
