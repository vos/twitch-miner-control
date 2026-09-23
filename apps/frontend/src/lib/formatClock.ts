/**
 * Clock times, always on a 24-hour dial.
 *
 * The browser locale still chooses the separator and the field order,
 * but never the dial: `hourCycle: "h23"` pins 00:00-23:59 everywhere, so
 * an en-US browser reads the same times as a de-DE one. That matters
 * because these strings sit in dense columns beside durations and
 * counts -- an "AM"/"PM" suffix is two more characters of width on every
 * row, and it re-sorts visually wrong when the eye scans a feed that is
 * already in reverse-chronological order.
 *
 * "h23" rather than `hour12: false`: the two disagree on midnight in
 * some locales, where hour12:false yields the h24 dial and prints
 * "24:00" for what every other row calls "00:00".
 *
 * Formatters are built once at module scope. Intl construction is the
 * expensive half of formatting, and the activity feed formats a fresh
 * string for every row on every render.
 */

/** Time of day: "09:05", "23:40". */
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export const formatClock = (ts: number): string => clock.format(ts);

/**
 * A date with its time, for labels that span more than one day.
 *
 * The hour keeps its minutes even on the hour. On a 24-hour dial an
 * hour alone renders as a bare number -- "Sep 17, 15" -- which reads as
 * a quantity, not a time; the 12-hour dial got away with it because
 * "3 PM" carries its own unit. ":00" is what makes it a clock time at a
 * glance.
 *
 * The date and the time are formatted separately and joined, rather than
 * asked for in one formatter, because a combined format inserts the
 * locale's own date/time separator ("at", ", ") and that stretches the
 * label past the width a compact label can hold.
 */
const dayOnly = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** Date without a time, for labels whose buckets are a day or wider. */
export const formatDay = (ts: number): string => dayOnly.format(ts);

export const formatDateHour = (ts: number): string =>
  `${dayOnly.format(ts)}, ${clock.format(ts)}`;
