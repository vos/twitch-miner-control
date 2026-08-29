import type { Db } from "./schema.js";

export interface PointSample { ts: number; balance: number }
export interface EventSample { ts: number; type: string }

export class History {
  constructor(private readonly db: Db) {}

  /** Writes only on change. Returns whether a row was inserted. */
  recordPoints(username: string, balance: number, ts = Date.now()): boolean {
    if (this.latest(username) === balance) return false;
    this.db
      .prepare("INSERT INTO point_snapshots (streamer, ts, balance) VALUES (?, ?, ?)")
      .run(username, ts, balance);
    return true;
  }

  latest(username: string): number | null {
    const row = this.db
      .prepare(
        "SELECT balance FROM point_snapshots WHERE streamer = ? ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(username) as { balance: number } | undefined;
    return row ? row.balance : null;
  }

  pointsSeries(username: string, fromTs: number, toTs: number): PointSample[] {
    return this.db
      .prepare(
        "SELECT ts, balance FROM point_snapshots WHERE streamer = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC",
      )
      .all(username, fromTs, toTs) as PointSample[];
  }

  /** Event type only. Message text is lossy and must never be stored. */
  recordEvent(type: string, ts = Date.now()): void {
    this.db.prepare("INSERT INTO events (ts, type) VALUES (?, ?)").run(ts, type);
  }

  recentEvents(limit: number): EventSample[] {
    return this.db
      .prepare("SELECT ts, type FROM events ORDER BY ts DESC, id DESC LIMIT ?")
      .all(limit) as EventSample[];
  }
}
