import { expect, test } from "vitest";
import { coverageRows } from "./coverageRows.js";

const HOUR = 3_600_000;
// 22:00 local, whatever the machine's zone: late enough that "a few hours
// ago" is still today, early enough that "yesterday afternoon to 2am"
// crosses a midnight. The rows are local days, so a UTC-pinned NOW would
// put those spans on different days depending on where the tests run.
const NOW = new Date(1970, 0, 10, 22).getTime();

test("returns one row per requested day, oldest first", () => {
  const rows = coverageRows([], [], 3, NOW);
  expect(rows).toHaveLength(3);
  expect(rows[0].dayStart).toBeLessThan(rows[2].dayStart);
});

test("a day with no streams has empty bands and zero totals", () => {
  const rows = coverageRows([], [], 1, NOW);
  expect(rows[0].live).toEqual([]);
  expect(rows[0].mined).toEqual([]);
  expect(rows[0].liveMs).toBe(0);
});

test("a stream inside one day produces a band on that day", () => {
  const rows = coverageRows([{ start: NOW - 3 * HOUR, end: NOW - HOUR }], [], 1, NOW);
  const today = rows[rows.length - 1];
  expect(today.live).toHaveLength(1);
  expect(today.liveMs).toBe(2 * HOUR);
});

test("bands are fractions of the day, between zero and one", () => {
  const rows = coverageRows([{ start: NOW - 3 * HOUR, end: NOW - HOUR }], [], 1, NOW);
  const band = rows[rows.length - 1].live[0];
  expect(band.startFraction).toBeGreaterThanOrEqual(0);
  expect(band.endFraction).toBeLessThanOrEqual(1);
  expect(band.startFraction).toBeLessThan(band.endFraction);
});

test("a stream spanning midnight appears on both days", () => {
  const rows = coverageRows([{ start: NOW - 30 * HOUR, end: NOW - 20 * HOUR }], [], 3, NOW);
  const touched = rows.filter((r) => r.live.length > 0);
  expect(touched.length).toBeGreaterThanOrEqual(2);
});

test("an open span is resolved against now rather than running forever", () => {
  const rows = coverageRows([{ start: NOW - 2 * HOUR, end: null }], [], 1, NOW);
  expect(rows[rows.length - 1].liveMs).toBe(2 * HOUR);
});

test("mined time is tracked separately from live time", () => {
  const rows = coverageRows(
    [{ start: NOW - 4 * HOUR, end: NOW }],
    [{ start: NOW - HOUR, end: NOW }],
    1, NOW,
  );
  const today = rows[rows.length - 1];
  expect(today.liveMs).toBe(4 * HOUR);
  expect(today.minedMs).toBe(HOUR);
});

test("rows stay on consecutive local midnights across a DST change", () => {
  // Late October and late March cover the common northern and southern
  // hemisphere switches; zones without DST pass trivially.
  for (const at of [new Date(2026, 9, 27, 12), new Date(2026, 3, 7, 12)]) {
    const rows = coverageRows([], [], 14, at.getTime());
    const dates = rows.map((r) => new Date(r.dayStart));
    expect(dates.every((d) => d.getHours() === 0 && d.getMinutes() === 0)).toBe(true);
    expect(new Set(dates.map((d) => d.toDateString())).size).toBe(14);
  }
});
