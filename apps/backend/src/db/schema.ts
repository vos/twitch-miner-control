import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS point_snapshots (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer TEXT    NOT NULL,
      ts       INTEGER NOT NULL,
      balance  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_streamer_ts
      ON point_snapshots (streamer, ts);

    CREATE TABLE IF NOT EXISTS events (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      ts   INTEGER NOT NULL,
      type TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
  `);
  return db;
}
