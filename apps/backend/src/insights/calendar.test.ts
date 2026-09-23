import { beforeEach, expect, test } from "vitest";
import { DailyPoints } from "../db/dailyPoints.js";
import { History } from "../db/history.js";
import { openDb } from "../db/schema.js";
import { Streamers } from "../db/streamers.js";
import { buildCalendar } from "./calendar.js";

const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).getTime();
const HOUR = 3_600_000;
const NOW = at(17, 12); // Thursday

let history: History;
let daily: DailyPoints;
let streamers: Streamers;
beforeEach(() => {
  const db = openDb(":memory:");
  history = new History(db);
  daily = new DailyPoints(db);
  streamers = new Streamers(db);
});

const deps = () => ({ history, daily, streamers });

function seedEarned() {
  daily.write("2026-09-14", new Map([["alpha", 100], ["beta", 300]]));
  daily.write("2026-09-15", new Map([["alpha", 50]]));
  // The 16th: no row -- nothing recorded that day.
  history.recordPoints("alpha", 1000, at(17, 9)); // today, live
  history.recordPoints("alpha", 1040, at(17, 10));
}

test("one entry per day, oldest first, ending today", () => {
  seedEarned();
  const { days } = buildCalendar(deps(), NOW, 7);
  expect(days.map((d) => d.date)).toEqual([
    "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14",
    "2026-09-15", "2026-09-16", "2026-09-17",
  ]);
});

test("each day totals what every channel earned, and names the top one", () => {
  seedEarned();
  streamers.see("beta", 1, "Beta");
  const byDate = new Map(buildCalendar(deps(), NOW, 7).days.map((d) => [d.date, d]));
  expect(byDate.get("2026-09-14")).toMatchObject({
    earned: 400, top: { login: "beta", displayName: "Beta", earned: 300 },
  });
  expect(byDate.get("2026-09-15")).toMatchObject({ earned: 50, top: { login: "alpha" } });
  expect(byDate.get("2026-09-16")).toMatchObject({ earned: 0, top: null });
  // Today comes from the live snapshots: the first is only a starting point.
  expect(byDate.get("2026-09-17")).toMatchObject({ earned: 40, top: { login: "alpha" } });
});

test("since is the first day with any record, so earlier days read as no data", () => {
  seedEarned();
  expect(buildCalendar(deps(), NOW, 7).since).toBe("2026-09-14");
});

test("nothing recorded at all: since is null", () => {
  expect(buildCalendar(deps(), NOW, 7).since).toBeNull();
});

test("a streak counts back from today, or from yesterday before today earns", () => {
  seedEarned();
  expect(buildCalendar(deps(), NOW, 7).streak).toEqual({ current: 1, longest: 2 });

  daily.write("2026-09-16", new Map([["alpha", 5]]));
  expect(buildCalendar(deps(), at(18, 0, 5), 7).streak)
    .toEqual({ current: 4, longest: 4 }); // 14th-17th; the 18th has not earned yet
});

test("mined time is live and miner-up at once, per day", () => {
  history.openMinerSession(at(16, 20));
  history.closeMinerSession(at(17, 2));
  history.openStreamerSession("alpha", "s1", at(16, 22), null);
  history.recordPoints("alpha", 5, at(17, 1));
  history.closeStreamerSessionsExcept("alpha", null, at(17, 1));
  const byDate = new Map(buildCalendar(deps(), NOW, 2).days.map((d) => [d.date, d]));
  expect(byDate.get("2026-09-16")?.minedMs).toBe(2 * HOUR);
  expect(byDate.get("2026-09-17")?.minedMs).toBe(1 * HOUR);
});
