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

test("lastWatchGain reports the newest watch gain for the streamer", () => {
  history.recordEvent("GAIN_FOR_WATCH", 1000, "+10 -> forsen", "forsen");
  history.recordEvent("GAIN_FOR_WATCH", 3000, "+10 -> forsen", "forsen");
  expect(history.lastWatchGain("forsen")).toBe(3000);
});

test("lastWatchGain ignores gains that are not for watching", () => {
  // A claim or a raid says points arrived, not that the miner holds a
  // watch slot -- which is the only thing this answers.
  history.recordEvent("GAIN_FOR_CLAIM", 2000, "+50 -> forsen", "forsen");
  history.recordEvent("GAIN_FOR_RAID", 2500, "+50 -> forsen", "forsen");
  expect(history.lastWatchGain("forsen")).toBeNull();
});

test("lastWatchGain does not read another streamer's watch gain", () => {
  history.recordEvent("GAIN_FOR_WATCH", 1000, "+10 -> forsen", "forsen");
  expect(history.lastWatchGain("alpha")).toBeNull();
});

test("lastWatchGain is null when an event could not be attributed", () => {
  // An ambiguous line is stored with a null streamer; it must not count
  // toward any channel.
  history.recordEvent("GAIN_FOR_WATCH", 1000, "+10 -> someone", null);
  expect(history.lastWatchGain("someone")).toBeNull();
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

test("opens one session per stream and ignores repeat sightings", () => {
  history.openStreamerSession("alpha", "S1", 1000, 500);
  history.openStreamerSession("alpha", "S1", 1000, 900);
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: null }]);
  // The anchor is the FIRST sighting's balance. A later tick must not
  // move it, or the per-stream gain would reset to zero every poll.
  expect(history.streamAnchor("alpha", "S1")).toBe(500);
});

test("records a stream joined late with its true start", () => {
  // We first looked at 9000, but Twitch says the stream began at 1000.
  history.openStreamerSession("alpha", "S1", 1000, 500);
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: null }]);
});

test("closes sessions other than the live one", () => {
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.recordPoints("alpha", 10, 5000);
  history.closeStreamerSessionsExcept("alpha", null, 5000);
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: 5000 }]);
});

test("leaves the live session open", () => {
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.closeStreamerSessionsExcept("alpha", "S1", 5000);
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: null }]);
});

test("closes a previous stream when a new one starts", () => {
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.recordPoints("alpha", 10, 4000);
  history.openStreamerSession("alpha", "S2", 6000, 20);
  history.closeStreamerSessionsExcept("alpha", "S2", 6000);
  expect(history.streamerSpans("alpha")).toEqual([
    { start: 1000, end: 4000 },
    { start: 6000, end: null },
  ]);
});

test("reports when a streamer was last live", () => {
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.recordPoints("alpha", 10, 5000);
  history.closeStreamerSessionsExcept("alpha", null, 5000);
  expect(history.lastLive("alpha")).toBe(5000);
});

test("reports no last-live while the streamer is live", () => {
  history.openStreamerSession("alpha", "S1", 1000, 0);
  expect(history.lastLive("alpha")).toBeNull();
});

test("reports no last-live for a streamer never seen live", () => {
  expect(history.lastLive("nobody")).toBeNull();
});

test("reports no anchor for an unknown stream", () => {
  expect(history.streamAnchor("alpha", "nope")).toBeNull();
});

test("tracks miner sessions with a heartbeat", () => {
  history.openMinerSession(1000);
  history.beatMinerSession(2000);
  history.closeMinerSession(3000);
  expect(history.minerSpans()).toEqual([{ start: 1000, end: 3000 }]);
});

test("closes a killed miner session at its heartbeat, not at boot", () => {
  // The process died after the 2000 heartbeat; boot happens much later.
  // Closing at boot would invent hours of mining that never happened.
  history.openMinerSession(1000);
  history.beatMinerSession(2000);
  history.recoverOpenSessions();
  expect(history.minerSpans()).toEqual([{ start: 1000, end: 2000 }]);
});

test("leaves streamer sessions open on recovery", () => {
  // They are keyed on Twitch's stream id, so the first post-boot poll
  // either matches the row or closes it. Nothing to guess at here.
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.recoverOpenSessions();
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: null }]);
});

test("closes a stream that ended during downtime at our last evidence", () => {
  // We recorded points up to 4000, then died. The stream is not live on
  // the next boot, so it must close where our evidence stops -- not at
  // the post-boot poll, which would bill the whole outage as online.
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.recordPoints("alpha", 10, 4000);
  history.closeStreamerSessionsExcept("alpha", null, 99_000);
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: 4000 }]);
});

test("closes a stream with no snapshots at its own start", () => {
  // No evidence we ever watched it. The row closes at its start, so it
  // survives as a zero-length span rather than staying open forever
  // claiming the channel is live. clip() drops it from every total.
  history.openStreamerSession("beta", "S9", 1000, 0);
  history.closeStreamerSessionsExcept("beta", null, 99_000);
  expect(history.streamerSpans("beta")).toEqual([{ start: 1000, end: 1000 }]);
});

test("never closes a session before it started", () => {
  // Snapshots predating the stream must not produce a negative span.
  history.recordPoints("gamma", 5, 500);
  history.openStreamerSession("gamma", "S1", 1000, 0);
  history.closeStreamerSessionsExcept("gamma", null, 99_000);
  expect(history.streamerSpans("gamma")).toEqual([{ start: 1000, end: 1000 }]);
});

test("filters spans by window", () => {
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.recordPoints("alpha", 10, 2000);
  history.closeStreamerSessionsExcept("alpha", null, 2000);
  expect(history.streamerSpans("alpha", 5000)).toEqual([]);
  expect(history.streamerSpans("alpha", 1500)).toHaveLength(1);
});

test("prunes snapshots older than the cutoff", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("alpha", 200, 9000);
  expect(history.prunePoints(5000)).toBe(1);
  expect(history.pointsSeries("alpha", 0, 99_999)).toEqual([{ ts: 9000, balance: 200 }]);
});

test("reports nothing pruned when everything is inside the window", () => {
  history.recordPoints("alpha", 100, 9000);
  expect(history.prunePoints(5000)).toBe(0);
});

test("leaves span tables alone when pruning", () => {
  // They are the source of the all-time mining figure; pruning them
  // would corrupt the number they exist to answer.
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.openMinerSession(1000);
  history.prunePoints(99_999);
  expect(history.streamerSpans("alpha")).toHaveLength(1);
  expect(history.minerSpans()).toHaveLength(1);
});
