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

    CREATE TABLE IF NOT EXISTS streamer_sessions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer  TEXT    NOT NULL,
      -- Twitch's stream id: the row's identity. One row per real stream,
      -- however many times we restart while it is running. Unique per
      -- channel rather than globally, hence the composite constraint.
      stream_id TEXT    NOT NULL,
      -- Twitch's own createdAt, not when our poller first looked, so a
      -- stream we joined late is still recorded with its true start.
      start_ts  INTEGER NOT NULL,
      end_ts    INTEGER,
      -- Balance at our first sighting of this stream: the gainedStream
      -- anchor, persisted so a restart cannot silently reset it to zero.
      anchor_points INTEGER,
      UNIQUE (streamer, stream_id)
    );
    CREATE INDEX IF NOT EXISTS idx_streamer_sessions_lookup
      ON streamer_sessions (streamer, start_ts);

    CREATE TABLE IF NOT EXISTS miner_sessions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      start_ts  INTEGER NOT NULL,
      end_ts    INTEGER,
      -- Refreshed every poll tick while RUNNING, so a hard kill leaves a
      -- last-known-good timestamp to close the row at on the next boot.
      heartbeat INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_miner_sessions_start ON miner_sessions (start_ts);

    CREATE TABLE IF NOT EXISTS streamer_profiles (
      login      TEXT PRIMARY KEY,
      -- NULL means "asked Twitch, no avatar". A missing row means
      -- "never asked" -- collapsing the two would re-fetch an
      -- avatarless channel on every single poll, forever.
      avatar_url TEXT,
      fetched_at INTEGER NOT NULL
    );
  `);
  addEventColumns(db);
  return db;
}

/**
 * Adds columns to an `events` table created before they existed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so a
 * database from an earlier run keeps its original shape and every insert
 * naming a newer column would fail. Guarded by a table_info scan because
 * SQLite has no `ADD COLUMN IF NOT EXISTS`.
 */
function addEventColumns(db: Db): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(events)").all() as { name: string }[])
      .map((column) => column.name),
  );
  if (!existing.has("message")) db.exec("ALTER TABLE events ADD COLUMN message TEXT");
  // Which streamer an event is about, attributed from the roster at write
  // time. NULL when no roster login could be identified in the message --
  // the shape every row had before this column existed.
  if (!existing.has("streamer")) db.exec("ALTER TABLE events ADD COLUMN streamer TEXT");
}
