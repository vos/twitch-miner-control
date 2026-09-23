import { expect, test } from "vitest";
import {
  collapseQuietDays, coverageRows, dayStretches, pointsBetween, stateAt,
} from "./coverageRows.js";

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

/** A row as collapseQuietDays sees it: only the fields it reads. */
const day = (offset: number, liveMs = 0) => ({
  dayStart: new Date(1970, 0, 10 - offset).getTime(),
  dayEnd: new Date(1970, 0, 11 - offset).getTime(),
  live: [], mined: [], liveMs, minedMs: 0,
});

test("collapse keeps a run of days that all have activity", () => {
  const rows = [day(2, HOUR), day(1, HOUR), day(0, HOUR)];
  expect(collapseQuietDays(rows).map((e) => e.kind)).toEqual(["day", "day", "day"]);
});

test("collapse drops quiet days at the ends rather than showing empty rows", () => {
  // The strip should open on the first day worth looking at, not on a
  // week of em dashes before the channel's first stream.
  const rows = [day(4), day(3), day(2, HOUR), day(1), day(0)];
  const out = collapseQuietDays(rows);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ kind: "day" });
});

test("collapse replaces an interior run of quiet days with one gap entry", () => {
  const rows = [day(5, HOUR), day(4), day(3), day(2), day(1), day(0, HOUR)];
  const out = collapseQuietDays(rows);
  expect(out.map((e) => e.kind)).toEqual(["day", "gap", "day"]);
  expect(out[1]).toMatchObject({ kind: "gap", days: 4 });
});

test("collapse leaves a single quiet day as its own row", () => {
  // One dark day between two streaming days costs a row either way, and
  // "1 day dark" is longer than the date it replaces.
  const rows = [day(2, HOUR), day(1), day(0, HOUR)];
  expect(collapseQuietDays(rows).map((e) => e.kind)).toEqual(["day", "day", "day"]);
});

test("collapse counts a day as quiet on live time, not mined time", () => {
  // A day the channel streamed and we mined none of it is the single
  // most important row in the block -- it is what the gap between the
  // two tones exists to show, and must never be collapsed away.
  const rows = [day(2, HOUR), day(1, 5 * HOUR), day(0, HOUR)];
  const out = collapseQuietDays(rows);
  expect(out.map((e) => e.kind)).toEqual(["day", "day", "day"]);
});

test("collapse returns nothing when no day in the window has activity", () => {
  // The caller renders its own empty state rather than a lone gap line.
  expect(collapseQuietDays([day(2), day(1), day(0)])).toEqual([]);
});

test("a band keeps its own times, cut at midnight", () => {
  // Yesterday 20:00 to today 02:00: today's band starts at its midnight.
  const rows = coverageRows([{ start: NOW - 26 * HOUR, end: NOW - 20 * HOUR }], [], 2, NOW);
  const today = rows[1];
  expect(today.live[0].start).toBe(today.dayStart);
  expect(today.live[0].end).toBe(NOW - 20 * HOUR);
  expect(rows[0].live[0].end).toBe(rows[0].dayEnd);
  expect(rows[0].dayEnd).toBe(today.dayStart);
});

test("each live stretch reports only the mining inside it", () => {
  const [day] = coverageRows(
    [{ start: NOW - 6 * HOUR, end: NOW - 4 * HOUR }, { start: NOW - 2 * HOUR, end: NOW }],
    [{ start: NOW - 5 * HOUR, end: NOW - 4 * HOUR }, { start: NOW - 2 * HOUR, end: NOW }],
    1, NOW,
  );
  expect(dayStretches(day).map((s) => s.minedMs)).toEqual([HOUR, 2 * HOUR]);
});

test("stateAt tells live-and-mined from live-and-missed from offline", () => {
  const [day] = coverageRows(
    [{ start: NOW - 4 * HOUR, end: NOW }],
    [{ start: NOW - 2 * HOUR, end: NOW }],
    1, NOW,
  );
  expect(stateAt(day, NOW - HOUR)).toEqual({ live: true, mined: true });
  expect(stateAt(day, NOW - 3 * HOUR)).toEqual({ live: true, mined: false });
  expect(stateAt(day, NOW - 6 * HOUR)).toEqual({ live: false, mined: false });
});

test("pointsBetween differences the balances in force at each end", () => {
  const series = [
    { ts: 100, balance: 1000 },
    { ts: 250, balance: 1300 },
    { ts: 400, balance: 1250 },
  ];
  expect(pointsBetween(series, 200, 300)).toBe(300);
  expect(pointsBetween(series, 200, 500)).toBe(250);
});

test("pointsBetween is unknown without a balance before the start", () => {
  // The first sample inside the window already carries its own gain.
  expect(pointsBetween([{ ts: 250, balance: 1300 }], 200, 300)).toBeNull();
});
