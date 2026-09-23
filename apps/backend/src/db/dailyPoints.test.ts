import { beforeEach, expect, test } from "vitest";
import { DailyPoints } from "./dailyPoints.js";
import { openDb } from "./schema.js";

let daily: DailyPoints;
beforeEach(() => { daily = new DailyPoints(openDb(":memory:")); });

test("a written day is known, with a row per streamer", () => {
  daily.write("2026-09-14", new Map([["beta", 300], ["alpha", 100]]));
  expect(daily.has("2026-09-14")).toBe(true);
  expect(daily.has("2026-09-15")).toBe(false);
  expect(daily.between("2026-09-14", "2026-09-14")).toEqual([
    { day: "2026-09-14", streamer: "alpha", earned: 100 },
    { day: "2026-09-14", streamer: "beta", earned: 300 },
  ]);
});

test("a day is written once; a second write leaves it alone", () => {
  daily.write("2026-09-14", new Map([["alpha", 100]]));
  daily.write("2026-09-14", new Map([["alpha", 999]]));
  expect(daily.between("2026-09-14", "2026-09-14")[0].earned).toBe(100);
});

test("between is inclusive and ordered by day", () => {
  daily.write("2026-09-16", new Map([["alpha", 3]]));
  daily.write("2026-09-14", new Map([["alpha", 1]]));
  daily.write("2026-09-15", new Map([["alpha", 2]]));
  expect(daily.between("2026-09-14", "2026-09-15").map((r) => r.earned)).toEqual([1, 2]);
});

test("the first day is the earliest written, or null", () => {
  expect(daily.firstDay()).toBeNull();
  daily.write("2026-09-15", new Map([["alpha", 1]]));
  daily.write("2026-09-14", new Map([["alpha", 1]]));
  expect(daily.firstDay()).toBe("2026-09-14");
});
