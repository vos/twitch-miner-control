export const HOURS_PER_WEEK = 168;
const WEEK_MS = 7 * 86_400_000;

/** One hour of the week, across the observed window. */
export interface ScheduleCell {
  /** Occurrences of this hour in which the channel was live. */
  live: number;
  /** Occurrences of this hour that fell wholly inside the window. */
  of: number;
}

export interface Schedule {
  /** Monday 00:00 first, local time. */
  cells: ScheduleCell[];
  /** How long the window is, in weeks. */
  weeks: number;
}

/** A local time's hour of the week, Monday first: 0 is Monday 00:00. */
export function hourOfWeek(date: Date): number {
  return ((date.getDay() + 6) % 7) * 24 + date.getHours();
}

/**
 * Buckets live spans into hours of the week, in the browser's timezone.
 *
 * Each cell counts its own occurrences in the window rather than dividing
 * by a global week count: in a window of two and a half weeks some hours
 * occurred three times and others twice, and scoring both out of the same
 * number would misreport one of them. Only whole hours inside the window
 * are counted, so an hour we watched ten minutes of is not scored as a
 * full observation.
 *
 * Hours are stepped with the Date constructor rather than by adding
 * 3,600,000, so a DST change skips or repeats a local hour the way the
 * clock does.
 */
export function bucketSchedule(
  spans: ReadonlyArray<{ start: number; end: number }>,
  since: number,
  now: number,
): Schedule {
  const cells = Array.from({ length: HOURS_PER_WEEK }, () => ({ live: 0, of: 0 }));

  let hour = new Date(since);
  hour.setMinutes(0, 0, 0);
  if (hour.getTime() < since) hour.setHours(hour.getHours() + 1);

  for (;;) {
    const next = new Date(
      hour.getFullYear(), hour.getMonth(), hour.getDate(), hour.getHours() + 1,
    );
    if (next.getTime() > now) break;
    const start = hour.getTime();
    const end = next.getTime();
    const cell = cells[hourOfWeek(hour)];
    cell.of += 1;
    if (spans.some((s) => s.start < end && s.end > start)) cell.live += 1;
    hour = next;
  }

  return { cells, weeks: Math.max(0, now - since) / WEEK_MS };
}
