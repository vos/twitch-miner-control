import type { Db } from "./schema.js";

export interface PointSample { ts: number; balance: number }
export interface EventSample { ts: number; type: string; message: string | null }

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

  /**
   * The balance in force at `ts`: the most recent snapshot at or before it.
   *
   * Not the *nearest* snapshot -- writes are change-only, so a balance
   * written at 1000 is still the truth at 4999 even when the next write
   * lands at 5000. Anchoring a gain to the nearer row would report a
   * delta that spans a change the window does not contain.
   */
  balanceAt(username: string, ts: number): number | null {
    const row = this.db
      .prepare(
        "SELECT balance FROM point_snapshots WHERE streamer = ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(username, ts) as { balance: number } | undefined;
    return row ? row.balance : null;
  }

  seriesSince(username: string, fromTs: number): PointSample[] {
    return this.db
      .prepare(
        "SELECT ts, balance FROM point_snapshots WHERE streamer = ? AND ts >= ? ORDER BY ts ASC",
      )
      .all(username, fromTs) as PointSample[];
  }

  pointsSeries(username: string, fromTs: number, toTs: number): PointSample[] {
    return this.db
      .prepare(
        "SELECT ts, balance FROM point_snapshots WHERE streamer = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC",
      )
      .all(username, fromTs, toTs) as PointSample[];
  }

  /**
   * The type plus the miner's own formatted line, which is the only place
   * the streamer's name survives -- the `Events` name alone is just
   * `GAIN_FOR_CLAIM`, which is what made the activity feed nameless.
   *
   * The message is display text and nothing else: balances inside it are
   * millified ("12.3k") and must never be parsed back into numbers. Point
   * history is recorded by recordPoints() from the state pipeline.
   */
  recordEvent(type: string, ts = Date.now(), message: string | null = null): void {
    this.db
      .prepare("INSERT INTO events (ts, type, message) VALUES (?, ?, ?)")
      .run(ts, type, message);
  }

  recentEvents(limit: number): EventSample[] {
    return this.db
      .prepare("SELECT ts, type, message FROM events ORDER BY ts DESC, id DESC LIMIT ?")
      .all(limit) as EventSample[];
  }
}
