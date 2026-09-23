export interface Span {
  start: number;
  /** Null while still running; resolved against `now` when read. */
  end: number | null;
}

/** A stretch of one day, as fractions of that day's width. */
export interface Band {
  startFraction: number;
  endFraction: number;
  /** The stretch's own times, already cut at the day's edges. */
  start: number;
  end: number;
}

export interface CoverageDay {
  /** Local midnight opening this day. */
  dayStart: number;
  /** Local midnight closing it -- not dayStart + 24h, across DST. */
  dayEnd: number;
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
      start,
      end,
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
      dayEnd: midnight(dayStart, 1),
      live: liveDay.bands,
      mined: minedDay.bands,
      liveMs: liveDay.ms,
      minedMs: minedDay.ms,
    });
  }
  return rows;
}

/** One live stretch of a day, with how much of it we were mining. */
export interface Stretch {
  start: number;
  end: number;
  minedMs: number;
}

/**
 * The day's live stretches, each with its own mined time.
 *
 * Measured against the day's mined bands rather than read off the
 * session table: a session there is a whole stream, which can cross
 * midnight, while these are already cut to this row.
 */
export function dayStretches(day: CoverageDay): Stretch[] {
  return day.live.map((band) => {
    let minedMs = 0;
    for (const m of day.mined) {
      const overlap = Math.min(band.end, m.end) - Math.max(band.start, m.start);
      if (overlap > 0) minedMs += overlap;
    }
    return { start: band.start, end: band.end, minedMs };
  });
}

/** Whether the channel was live, and whether we were mining, at `ts`. */
export function stateAt(day: CoverageDay, ts: number): { live: boolean; mined: boolean } {
  const inside = (b: Band) => ts >= b.start && ts < b.end;
  return { live: day.live.some(inside), mined: day.mined.some(inside) };
}

/**
 * Points gained between two instants, from change-only balance samples.
 *
 * Null when no sample sits at or before `from`: the series is clipped to
 * the fetched window, and without a balance in force at the start there
 * is nothing honest to subtract from -- the first sample inside the day
 * already carries its own gain.
 */
export function pointsBetween(
  series: { ts: number; balance: number }[],
  from: number,
  to: number,
): number | null {
  let opening: number | null = null;
  let closing: number | null = null;
  for (const s of series) {
    if (s.ts <= from) opening = s.balance;
    if (s.ts <= to) closing = s.balance;
  }
  return opening === null || closing === null ? null : closing - opening;
}

/** A rendered row: either one day, or a stretch of days with no stream. */
export type CoverageEntry =
  | { kind: "day"; day: CoverageDay }
  | { kind: "gap"; days: number; from: number; to: number };

/**
 * Minimum consecutive quiet days before they are collapsed into one line.
 *
 * Two, because collapsing a single day saves nothing: "1 day dark" is
 * wider than the date it would replace, and the row is spent either way.
 */
const MIN_GAP = 2;

/**
 * Trims and collapses the days a channel did not stream.
 *
 * The strip is a calendar, and under the longer ranges most of it can be
 * empty -- a channel streaming twice a week fills two rows of fourteen
 * and spends the other twelve on em dashes. Simply dropping them would
 * break what the strip is: consecutive rows would no longer be
 * consecutive days, so a fortnight of silence would read exactly like
 * daily streaming.
 *
 * So the ends are trimmed -- there is nothing before a channel's first
 * stream to describe -- and an interior run becomes one line that says
 * how long it was. The gap stays visible and stops costing a row a day.
 *
 * Quiet means `liveMs === 0`: the channel did not stream at all. A day it
 * streamed and we mined none of is emphatically NOT quiet -- that row is
 * the whole point of the block.
 */
export function collapseQuietDays(rows: CoverageDay[]): CoverageEntry[] {
  const active = rows.map((r) => r.liveMs > 0);
  const first = active.indexOf(true);
  // No day in the window saw a stream: the caller says so itself rather
  // than rendering a single gap line describing the entire range.
  if (first === -1) return [];
  const last = active.lastIndexOf(true);

  const out: CoverageEntry[] = [];
  for (let i = first; i <= last; i += 1) {
    if (active[i]) {
      out.push({ kind: "day", day: rows[i] });
      continue;
    }
    // A run of quiet days, bounded by the active days on either side --
    // `last` guarantees there is one ahead, so this never runs off.
    let end = i;
    while (!active[end + 1]) end += 1;
    const days = end - i + 1;
    if (days >= MIN_GAP) {
      out.push({ kind: "gap", days, from: rows[i].dayStart, to: rows[end].dayStart });
    } else {
      for (let j = i; j <= end; j += 1) out.push({ kind: "day", day: rows[j] });
    }
    i = end;
  }
  return out;
}
