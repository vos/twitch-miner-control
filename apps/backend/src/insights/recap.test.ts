import { beforeEach, expect, test } from "vitest";
import { DailyPoints } from "../db/dailyPoints.js";
import { History } from "../db/history.js";
import { openDb } from "../db/schema.js";
import { Streamers } from "../db/streamers.js";
import { buildDaySummary, buildRecap } from "./recap.js";

const at = (month: number, day: number, hour: number, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).getTime();
const HOUR = 3_600_000;
const NOW = at(9, 17, 12); // Thursday; this week is Mon 14th - Sun 20th

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

/** A finished stream; sessions close at the latest snapshot, written at `end`. */
function stream(login: string, id: string, start: number, end: number, balance: number) {
  history.openStreamerSession(login, id, start, null);
  history.recordPoints(login, balance, end);
  history.closeStreamerSessionsExcept(login, null, end);
}

function seed() {
  daily.write("2026-09-08", new Map([["alpha", 70]])); // last week
  daily.write("2026-09-14", new Map([["alpha", 100], ["beta", 300]]));
  daily.write("2026-09-15", new Map([["alpha", 50]]));
  history.openMinerSession(at(9, 14, 0));
  history.closeMinerSession(at(9, 14, 12));
  // Snapshots on the 14th, already rolled up, so they only close sessions.
  stream("alpha", "a1", at(9, 14, 6), at(9, 14, 8), 1000);
  stream("gamma", "g1", at(9, 14, 8), at(9, 14, 11), 1);
  // Today, live: 1000 -> 1040.
  history.recordPoints("alpha", 1040, at(9, 17, 10));
  history.recordEvent("BONUS_CLAIM", at(9, 15, 10), null, "alpha");
  history.recordEvent("BONUS_CLAIM", at(9, 16, 10), null, "alpha");
  history.recordEvent("JOIN_RAID", at(9, 16, 1), null, "beta");
  history.recordEvent("BONUS_CLAIM", at(9, 10, 1), null, "alpha"); // last week
  streamers.see("beta", 1, "Beta");
  streamers.putProfile("beta", "https://cdn/beta.png", 1);
}

test("this week runs from Monday to now and is partial", () => {
  seed();
  const { period } = buildRecap(deps(), NOW, "week", 0);
  expect(period).toEqual({ kind: "week", from: at(9, 14, 0), to: NOW, partial: true });
});

test("totals add up the week so far", () => {
  seed();
  const { totals } = buildRecap(deps(), NOW, "week", 0);
  expect(totals.earned).toBe(490); // 400 + 50 + 40 today
  expect(totals.minedMs).toBe(5 * HOUR); // alpha 2h + gamma 3h
  expect(totals.streams).toBe(2);
  expect(totals.uptimePct).toBe(14); // 12h up of the 84h so far
});

test("last week is there to compare against, and a period with nothing is null", () => {
  seed();
  expect(buildRecap(deps(), NOW, "week", 0).previous?.earned).toBe(70);
  expect(buildRecap(deps(), NOW, "month", 0).previous).toBeNull(); // August
});

test("the top three are by points earned, with names and avatars", () => {
  seed();
  const { top } = buildRecap(deps(), NOW, "week", 0);
  expect(top.map((c) => [c.login, c.earned])).toEqual([["beta", 300], ["alpha", 190]]);
  expect(top[0]).toMatchObject({ displayName: "Beta", avatarUrl: "https://cdn/beta.png" });
});

test("most watched is named only when it is not already on the podium", () => {
  seed();
  expect(buildRecap(deps(), NOW, "week", 0).mostWatched)
    .toMatchObject({ login: "gamma", minedMs: 3 * HOUR });
});

test("highlights: best day, longest streak and event counts in the period", () => {
  seed();
  expect(buildRecap(deps(), NOW, "week", 0).highlights).toEqual({
    bestDay: { date: "2026-09-14", earned: 400 },
    longestStreak: 2,
    bonusClaims: 2,
    raids: 1,
    dropsClaimed: 0,
    watchStreakBonuses: 0,
  });
});

test("an earlier week is complete, not partial", () => {
  seed();
  const recap = buildRecap(deps(), NOW, "week", -1);
  expect(recap.period).toEqual({
    kind: "week", from: at(9, 7, 0), to: at(9, 14, 0), partial: false,
  });
  expect(recap.totals.earned).toBe(70);
  expect(recap.highlights.bonusClaims).toBe(1);
});

test("a month starts on the first", () => {
  seed();
  const { period, totals } = buildRecap(deps(), NOW, "month", 0);
  expect(period.from).toBe(at(9, 1, 0));
  expect(totals.earned).toBe(560);
});

test("channels mined at the same time count once: mined is time spent mining", () => {
  seed();
  // Beta overlaps both alpha (06-08) and gamma (08-11); added up it would
  // read 7h, but the miner only spent 06-11 on anything.
  stream("beta", "b1", at(9, 14, 7), at(9, 14, 9), 2);
  const { totals } = buildRecap(deps(), NOW, "week", 0);
  expect(totals.minedMs).toBe(5 * HOUR);
  expect(totals.streams).toBe(3);
});

// --- one day, for the digest ---

test("a day's summary adds up that day alone", () => {
  seed();
  history.recordEvent("DROP_CLAIM", at(9, 14, 9), "Claim X", "alpha");
  expect(buildDaySummary(deps(), "2026-09-14", NOW)).toEqual({
    day: "2026-09-14",
    earned: 400,
    minedMs: 5 * HOUR,
    dropsClaimed: 1,
    top: { login: "beta", displayName: "Beta", earned: 300 },
    hasData: true,
  });
});

test("a day with nothing recorded says so", () => {
  seed();
  expect(buildDaySummary(deps(), "2026-09-12", NOW)).toMatchObject({ hasData: false, earned: 0, top: null });
});
