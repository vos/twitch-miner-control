import { beforeEach, expect, test, afterEach } from "vitest";
import { openDb } from "./schema.js";
import { History } from "./history.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let history: History;
beforeEach(() => { history = new History(openDb(":memory:")); });

test("records a first balance", () => {
  expect(history.recordPoints("alpha", 100, 1000)).toBe(true);
  expect(history.pointsSeries("alpha", 0, 9999)).toEqual([{ ts: 1000, balance: 100 }]);
});

test("skips writes when the balance has not changed", () => {
  history.recordPoints("alpha", 100, 1000);
  expect(history.recordPoints("alpha", 100, 2000)).toBe(false);
  expect(history.pointsSeries("alpha", 0, 9999)).toHaveLength(1);
});

test("records a write when the balance changes", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("alpha", 150, 2000);
  expect(history.pointsSeries("alpha", 0, 9999)).toEqual([
    { ts: 1000, balance: 100 },
    { ts: 2000, balance: 150 },
  ]);
});

test("tracks streamers independently", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("beta", 100, 1000);
  expect(history.recordPoints("beta", 200, 2000)).toBe(true);
  expect(history.latest("alpha")).toBe(100);
  expect(history.latest("beta")).toBe(200);
});

test("filters the series by time range", () => {
  history.recordPoints("alpha", 1, 1000);
  history.recordPoints("alpha", 2, 2000);
  history.recordPoints("alpha", 3, 3000);
  expect(history.pointsSeries("alpha", 1500, 2500)).toEqual([{ ts: 2000, balance: 2 }]);
});

test("latest returns null for an unknown streamer", () => {
  expect(history.latest("ghost")).toBe(null);
});

test("stores event types only, never message text", () => {
  history.recordEvent("STREAMER_ONLINE", 1000);
  history.recordEvent("GAIN_FOR_CLAIM", 2000);
  expect(history.recentEvents(10)).toEqual([
    { ts: 2000, type: "GAIN_FOR_CLAIM" },
    { ts: 1000, type: "STREAMER_ONLINE" },
  ]);
});

test("recentEvents respects the limit and returns newest first", () => {
  for (let i = 1; i <= 5; i++) history.recordEvent("BONUS_CLAIM", i * 1000);
  expect(history.recentEvents(2).map((e) => e.ts)).toEqual([5000, 4000]);
});

test("reopening the same database keeps the data", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "history-test-"));
  const dbPath = join(tempDir, "test.db");

  try {
    // Write data and close the connection
    const db1 = openDb(dbPath);
    const first = new History(db1);
    first.recordPoints("alpha", 42, 1000);
    first.recordEvent("TEST_EVENT", 500);
    db1.close();

    // Reopen and verify data persists
    const db2 = openDb(dbPath);
    const second = new History(db2);
    expect(second.latest("alpha")).toBe(42);
    expect(second.pointsSeries("alpha", 0, 9999)).toEqual([{ ts: 1000, balance: 42 }]);
    expect(second.recentEvents(10)).toEqual([{ ts: 500, type: "TEST_EVENT" }]);
    db2.close();
  } finally {
    rmSync(tempDir, { recursive: true });
  }
});
