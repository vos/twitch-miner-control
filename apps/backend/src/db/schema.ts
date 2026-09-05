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
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      type    TEXT    NOT NULL,
      -- The miner's own formatted line, or NULL for rows written before
      -- the doorbell carried one. Display text only: balances inside it
      -- are millified and lossy (see python/helpers/doorbell.py).
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

    CREATE TABLE IF NOT EXISTS streamer_profiles (
      login      TEXT PRIMARY KEY,
      -- NULL means "asked Twitch, no avatar". A missing row means
      -- "never asked" -- collapsing the two would re-fetch an
      -- avatarless channel on every single poll, forever.
      avatar_url TEXT,
      fetched_at INTEGER NOT NULL
    );
  `);
  addEventMessageColumn(db);
  return db;
}

/**
 * Adds `events.message` to a database created before the column existed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so a
 * database from an earlier run keeps the two-column shape and every insert
 * naming `message` would fail. Guarded by a table_info scan because
 * SQLite has no `ADD COLUMN IF NOT EXISTS`.
 */
function addEventMessageColumn(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(events)").all() as { name: string }[];
  if (columns.some((column) => column.name === "message")) return;
  db.exec("ALTER TABLE events ADD COLUMN message TEXT");
}
