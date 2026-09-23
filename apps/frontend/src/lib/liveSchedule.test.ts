import { expect, test } from "vitest";
import { bucketSchedule, hourOfWeek, HOURS_PER_WEEK } from "./liveSchedule.js";

// Local time on purpose: the grid is laid out in the viewer's timezone.
// September 2026 has no DST change; the 7th, 14th and 21st are Mondays.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).getTime();
const cell = (weekday: number, hour: number) => weekday * 24 + hour; // 0 = Monday

const SINCE = at(7, 0);
const NOW = at(21, 0); // exactly two weeks

test("hour of week is Monday-first", () => {
  expect(hourOfWeek(new Date(at(7, 0)))).toBe(0);
  expect(hourOfWeek(new Date(at(8, 20, 30)))).toBe(cell(1, 20));
  expect(hourOfWeek(new Date(at(13, 23)))).toBe(HOURS_PER_WEEK - 1);
});

test("every hour of a two-week window is observed twice", () => {
  const { cells, weeks } = bucketSchedule([], SINCE, NOW);
  expect(cells).toHaveLength(HOURS_PER_WEEK);
  expect(cells.every((c) => c.of === 2 && c.live === 0)).toBe(true);
  expect(weeks).toBe(2);
});

test("a stream marks each hour it touches", () => {
  const { cells } = bucketSchedule([{ start: at(8, 20, 30), end: at(8, 21, 10) }], SINCE, NOW);
  expect(cells[cell(1, 19)]).toEqual({ live: 0, of: 2 });
  expect(cells[cell(1, 20)]).toEqual({ live: 1, of: 2 });
  expect(cells[cell(1, 21)]).toEqual({ live: 1, of: 2 });
  expect(cells[cell(1, 22)]).toEqual({ live: 0, of: 2 });
});

test("a stream across midnight and the week boundary lands on both days", () => {
  // Sunday 23:30 to Monday 00:30.
  const { cells } = bucketSchedule([{ start: at(13, 23, 30), end: at(14, 0, 30) }], SINCE, NOW);
  expect(cells[cell(6, 23)].live).toBe(1);
  expect(cells[cell(0, 0)].live).toBe(1);
});

test("the same hour in both weeks counts twice; two streams in one hour count once", () => {
  const { cells } = bucketSchedule([
    { start: at(8, 20, 0), end: at(8, 20, 10) },
    { start: at(8, 20, 40), end: at(8, 20, 50) },
    { start: at(15, 20, 5), end: at(15, 20, 55) },
  ], SINCE, NOW);
  expect(cells[cell(1, 20)]).toEqual({ live: 2, of: 2 });
});

test("only whole hours inside the window are observed", () => {
  // Wednesday 12:15: the 12:00 hour that day is only partly observed.
  const { cells, weeks } = bucketSchedule([], at(9, 12, 15), NOW);
  expect(cells[cell(2, 12)].of).toBe(1); // only the 16th
  expect(cells[cell(2, 13)].of).toBe(2); // the 9th and the 16th
  expect(cells[cell(0, 0)].of).toBe(1); // the 14th; the 21st has not finished
  expect(weeks).toBeCloseTo((NOW - at(9, 12, 15)) / (7 * 86_400_000));
});

test("an empty window observes nothing", () => {
  const { cells, weeks } = bucketSchedule([], NOW, NOW);
  expect(cells.every((c) => c.of === 0)).toBe(true);
  expect(weeks).toBe(0);
});
