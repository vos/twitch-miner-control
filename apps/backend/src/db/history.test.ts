import { beforeEach, expect, test, afterEach } from "vitest";
import Database from "better-sqlite3";
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

test("stores the event type alongside the miner's own message", () => {
  history.recordEvent("STREAMER_ONLINE", 1000, "forsen is now streaming");
  history.recordEvent("GAIN_FOR_CLAIM", 2000, "+50 -> forsen");
  expect(history.recentEvents(10)).toEqual([
    { ts: 2000, type: "GAIN_FOR_CLAIM", message: "+50 -> forsen" },
    { ts: 1000, type: "STREAMER_ONLINE", message: "forsen is now streaming" },
  ]);
});

test("an event recorded without a message stores null", () => {
  history.recordEvent("BONUS_CLAIM", 1000);
  expect(history.recentEvents(10)).toEqual([
    { ts: 1000, type: "BONUS_CLAIM", message: null },
  ]);
});

test("adds the message column to a database created without it", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "history-migrate-"));
  const dbPath = join(tempDir, "test.db");
  try {
    // The pre-message shape, as an existing deployment has it on disk.
    const legacy = new Database(dbPath);
    legacy.exec(
      "CREATE TABLE events (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "ts INTEGER NOT NULL," +
        "type TEXT NOT NULL)",
    );
    legacy.prepare("INSERT INTO events (ts, type) VALUES (?, ?)").run(500, "OLD_EVENT");
    legacy.close();

    // The old row survives the migration and reads back with no message,
    // and a new row writes against the widened table.
    const db = openDb(dbPath);
    const migrated = new History(db);
    migrated.recordEvent("NEW_EVENT", 1500, "forsen is now streaming");
    expect(migrated.recentEvents(10)).toEqual([
      { ts: 1500, type: "NEW_EVENT", message: "forsen is now streaming" },
      { ts: 500, type: "OLD_EVENT", message: null },
    ]);
    db.close();
  } finally {
    rmSync(tempDir, { recursive: true });
  }
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
    expect(second.recentEvents(10)).toEqual([
      { ts: 500, type: "TEST_EVENT", message: null },
    ]);
    db2.close();
  } finally {
    rmSync(tempDir, { recursive: true });
  }
});

test("balanceAt returns the balance in force at a moment, not the nearest one", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("alpha", 500, 5000);
  // 4900 is nearer to 5000, but at that instant the balance was still 100.
  expect(history.balanceAt("alpha", 4900)).toBe(100);
  expect(history.balanceAt("alpha", 5000)).toBe(500);
});

test("balanceAt returns null before the first snapshot", () => {
  history.recordPoints("alpha", 100, 1000);
  expect(history.balanceAt("alpha", 999)).toBe(null);
});

test("balanceAt is per streamer", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("beta", 700, 1000);
  expect(history.balanceAt("beta", 2000)).toBe(700);
});

test("seriesSince returns ascending samples from the cutoff", () => {
  history.recordPoints("alpha", 1, 1000);
  history.recordPoints("alpha", 2, 2000);
  history.recordPoints("alpha", 3, 3000);
  expect(history.seriesSince("alpha", 2000)).toEqual([
    { ts: 2000, balance: 2 },
    { ts: 3000, balance: 3 },
  ]);
});

test("earliestSample returns the first known snapshot with its timestamp", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("alpha", 500, 5000);
  expect(history.earliestSample("alpha")).toEqual({ ts: 1000, balance: 100 });
});

test("earliestSample returns null for a streamer with no history", () => {
  expect(history.earliestSample("ghost")).toBe(null);
});

test("earliestSample is per streamer", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("beta", 700, 2000);
  expect(history.earliestSample("beta")).toEqual({ ts: 2000, balance: 700 });
});
