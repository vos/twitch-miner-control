import { expect, test } from "vitest";
import { sessionRows } from "./sessionRows.js";

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

const session = (over: Partial<Parameters<typeof sessionRows>[0][number]> = {}) => ({
  streamId: "s1", start: NOW - 4 * HOUR, end: NOW - 2 * HOUR,
  mined: 2 * HOUR, earned: 500, ...over,
});

test("computes length from start and end", () => {
  expect(sessionRows([session()], NOW)[0].length).toBe(2 * HOUR);
});

test("an open session is marked live and measured to now", () => {
  const row = sessionRows([session({ end: null, start: NOW - HOUR })], NOW)[0];
  expect(row.live).toBe(true);
  expect(row.length).toBe(HOUR);
});

test("coverage is the mined fraction of the stream", () => {
  const row = sessionRows([session({ mined: HOUR })], NOW)[0];
  expect(row.coverage).toBeCloseTo(0.5);
});

test("coverage of a zero-length stream is null, not a division by zero", () => {
  const row = sessionRows([session({ start: NOW, end: NOW, mined: 0 })], NOW)[0];
  expect(row.coverage).toBeNull();
});

test("coverage never exceeds one even if mined overshoots", () => {
  // Clock skew between the session table and the miner spans must not
  // produce a 140% coverage badge.
  const row = sessionRows([session({ mined: 9 * HOUR })], NOW)[0];
  expect(row.coverage).toBe(1);
});

test("a null earned stays null rather than becoming zero", () => {
  expect(sessionRows([session({ earned: null })], NOW)[0].earned).toBeNull();
});

test("preserves the order it is given", () => {
  const rows = sessionRows(
    [session({ streamId: "b" }), session({ streamId: "a" })], NOW,
  );
  expect(rows.map((r) => r.streamId)).toEqual(["b", "a"]);
});
