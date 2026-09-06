import { expect, test } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "./schema.js";

const columns = (db: Db, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name);

test("creates the span tables", () => {
  const db = openDb(":memory:");
  expect(columns(db, "streamer_sessions")).toEqual(
    expect.arrayContaining([
      "streamer", "stream_id", "start_ts", "end_ts", "anchor_points",
    ]),
  );
  expect(columns(db, "miner_sessions")).toEqual(
    expect.arrayContaining(["start_ts", "end_ts", "heartbeat"]),
  );
});

test("keeps one row per real stream", () => {
  const db = openDb(":memory:");
  const insert = () => db.prepare(
    "INSERT INTO streamer_sessions (streamer, stream_id, start_ts) VALUES (?, ?, ?)",
  ).run("alpha", "S1", 1000);
  insert();
  // A restart mid-stream must not open a second row for the same stream.
  expect(insert).toThrow(/UNIQUE/);
});

test("lets two streamers share a stream id", () => {
  // Stream ids are unique per channel, not globally, and the constraint
  // must not collapse two channels into one row.
  const db = openDb(":memory:");
  const insert = (streamer: string) => db.prepare(
    "INSERT INTO streamer_sessions (streamer, stream_id, start_ts) VALUES (?, ?, ?)",
  ).run(streamer, "S1", 1000);
  insert("alpha");
  expect(() => insert("beta")).not.toThrow();
});

test("adds new event columns to a database created before they existed", () => {
  // Simulates an existing install. CREATE TABLE IF NOT EXISTS is a no-op
  // against an existing table, so without the migration guard every
  // insert naming `streamer` would fail against an older database.
  const dir = mkdtempSync(join(tmpdir(), "schema-"));
  const file = join(dir, "history.db");
  const old = new Database(file);
  old.exec(
    "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL)",
  );
  old.close();

  const db = openDb(file);
  expect(columns(db, "events")).toEqual(expect.arrayContaining(["message", "streamer"]));
  // The migration must be idempotent: reopening must not fail on a
  // duplicate column.
  db.close();
  const again = openDb(file);
  expect(columns(again, "events")).toContain("streamer");
  again.close();
  rmSync(dir, { recursive: true, force: true });
});
