import { beforeEach, expect, test } from "vitest";
import { DailyPoints } from "../db/dailyPoints.js";
import { History } from "../db/history.js";
import { openDb } from "../db/schema.js";
import { earnedByStreamer, rollupDays } from "./rollup.js";

// Local time; September 2026 has no DST change.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).getTime();

let history: History;
let daily: DailyPoints;
beforeEach(() => {
  const db = openDb(":memory:");
  history = new History(db);
  daily = new DailyPoints(db);
});

test("a day's first snapshot counts against the last one before midnight", () => {
  history.recordPoints("alpha", 100, at(14, 23));
  history.recordPoints("alpha", 130, at(15, 1));
  expect(earnedByStreamer(history, at(15, 0), at(16, 0))).toEqual(new Map([["alpha", 30]]));
});

test("rolls each complete day up once, and never today", () => {
  history.recordPoints("alpha", 100, at(14, 10));
  history.recordPoints("alpha", 150, at(14, 12));
  history.recordPoints("alpha", 120, at(14, 15)); // spent 30
  history.recordPoints("alpha", 200, at(15, 9));
  history.recordPoints("alpha", 260, at(16, 8)); // today
  expect(rollupDays({ history, daily }, at(16, 12))).toBe(2);
  expect(daily.between("2026-09-01", "2026-09-30")).toEqual([
    { day: "2026-09-14", streamer: "alpha", earned: 50 },
    { day: "2026-09-15", streamer: "alpha", earned: 80 },
  ]);
});

test("a written day is never recomputed", () => {
  history.recordPoints("alpha", 100, at(14, 10));
  history.recordPoints("alpha", 150, at(14, 12));
  rollupDays({ history, daily }, at(15, 12));
  // A late snapshot for a day already written changes nothing.
  history.recordPoints("alpha", 999, at(14, 20));
  expect(rollupDays({ history, daily }, at(15, 12))).toBe(0);
  expect(daily.between("2026-09-14", "2026-09-14")[0].earned).toBe(50);
});

test("a day without snapshots writes nothing, so it reads as no data", () => {
  history.recordPoints("alpha", 100, at(14, 10));
  history.recordPoints("alpha", 150, at(16, 10));
  rollupDays({ history, daily }, at(17, 12));
  expect(daily.has("2026-09-15")).toBe(false);
  expect(daily.between("2026-09-16", "2026-09-16")[0].earned).toBe(50);
});

test("rolled-up days survive the prune that follows", () => {
  history.recordPoints("alpha", 100, at(14, 10));
  history.recordPoints("alpha", 150, at(14, 12));
  rollupDays({ history, daily }, at(16, 12));
  history.prunePoints(at(16, 0));
  rollupDays({ history, daily }, at(16, 12));
  expect(daily.between("2026-09-14", "2026-09-14")[0].earned).toBe(50);
});

test("nothing recorded, nothing to roll", () => {
  expect(rollupDays({ history, daily }, at(16, 12))).toBe(0);
});
