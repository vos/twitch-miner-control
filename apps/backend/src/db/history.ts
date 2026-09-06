import type { Db } from "./schema.js";
import type { Span } from "../state/spans.js";

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

  /**
   * The oldest snapshot on record, used as a fallback window start when a
   * streamer has been tracked for less than the requested window.
   */
  earliestSample(username: string): PointSample | null {
    const row = this.db
      .prepare(
        "SELECT ts, balance FROM point_snapshots WHERE streamer = ? ORDER BY ts ASC, id ASC LIMIT 1",
      )
      .get(username) as PointSample | undefined;
    return row ?? null;
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
  recordEvent(
    type: string,
    ts = Date.now(),
    message: string | null = null,
    streamer: string | null = null,
  ): void {
    this.db
      .prepare("INSERT INTO events (ts, type, message, streamer) VALUES (?, ?, ?, ?)")
      .run(ts, type, message, streamer);
  }

  /**
   * The newest attributed event for a streamer, for the card's activity
   * line. Unattributed rows (streamer NULL) are invisible here by
   * design -- they are still in the feed, which shows every event.
   */
  lastActivity(streamer: string): { ts: number; type: string } | null {
    const row = this.db
      .prepare(
        "SELECT ts, type FROM events WHERE streamer = ? ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(streamer) as { ts: number; type: string } | undefined;
    return row ?? null;
  }

  /**
   * Records the first sighting of a stream. Idempotent per stream.
   *
   * `ON CONFLICT DO NOTHING` is what makes this restart-proof. It is
   * called on every tick a streamer is live, not on an observed
   * transition, so the second and thousandth sighting of the same stream
   * must leave the row -- and crucially its anchor balance -- untouched.
   */
  openStreamerSession(
    streamer: string,
    streamId: string,
    startTs: number,
    anchorPoints: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO streamer_sessions (streamer, stream_id, start_ts, anchor_points)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (streamer, stream_id) DO NOTHING`,
      )
      .run(streamer, streamId, startTs, anchorPoints);
  }

  /**
   * Closes every open session for a streamer except the one still live.
   *
   * The end time is clamped to the streamer's last point snapshot. If the
   * backend was down when the stream ended, `endTs` is the first
   * post-boot poll, and using it directly would bill the entire outage as
   * online time; the last snapshot is the last moment we were
   * demonstrably watching. The MAX(start_ts, ...) floor keeps a stream
   * with no snapshots at all -- or only ones predating it -- from closing
   * before it opened, which would be a negative span.
   */
  closeStreamerSessionsExcept(
    streamer: string,
    liveStreamId: string | null,
    endTs: number,
  ): void {
    const last = this.db
      .prepare("SELECT MAX(ts) AS ts FROM point_snapshots WHERE streamer = ?")
      .get(streamer) as { ts: number | null };
    const evidence = last.ts === null ? null : Math.min(endTs, last.ts);
    this.db
      .prepare(
        `UPDATE streamer_sessions
            SET end_ts = MAX(start_ts, COALESCE(?, start_ts))
          WHERE streamer = ? AND end_ts IS NULL
            AND (? IS NULL OR stream_id != ?)`,
      )
      .run(evidence, streamer, liveStreamId, liveStreamId);
  }

  /** A streamer's online spans, oldest first, limited to those
   *  overlapping `fromTs` onward. */
  streamerSpans(streamer: string, fromTs = 0): Span[] {
    return this.db
      .prepare(
        `SELECT start_ts AS start, end_ts AS end FROM streamer_sessions
          WHERE streamer = ? AND (end_ts IS NULL OR end_ts >= ?)
          ORDER BY start_ts ASC`,
      )
      .all(streamer, fromTs) as Span[];
  }

  /** The balance when we first saw this stream; the gainedStream anchor. */
  streamAnchor(streamer: string, streamId: string): number | null {
    const row = this.db
      .prepare(
        "SELECT anchor_points FROM streamer_sessions WHERE streamer = ? AND stream_id = ?",
      )
      .get(streamer, streamId) as { anchor_points: number | null } | undefined;
    return row?.anchor_points ?? null;
  }

  /** When this streamer was last live; null while live, or if never seen. */
  lastLive(streamer: string): number | null {
    const open = this.db
      .prepare(
        "SELECT 1 FROM streamer_sessions WHERE streamer = ? AND end_ts IS NULL LIMIT 1",
      )
      .get(streamer);
    if (open) return null;
    const row = this.db
      .prepare("SELECT MAX(end_ts) AS ts FROM streamer_sessions WHERE streamer = ?")
      .get(streamer) as { ts: number | null };
    return row.ts;
  }

  openMinerSession(startTs: number): void {
    this.db
      .prepare("INSERT INTO miner_sessions (start_ts, heartbeat) VALUES (?, ?)")
      .run(startTs, startTs);
  }

  /** Marks the open miner session alive; the recovery point after a kill. */
  beatMinerSession(ts: number): void {
    this.db
      .prepare("UPDATE miner_sessions SET heartbeat = ? WHERE end_ts IS NULL")
      .run(ts);
  }

  closeMinerSession(endTs: number): void {
    this.db
      .prepare("UPDATE miner_sessions SET end_ts = ? WHERE end_ts IS NULL")
      .run(endTs);
  }

  minerSpans(fromTs = 0): Span[] {
    return this.db
      .prepare(
        `SELECT start_ts AS start, end_ts AS end FROM miner_sessions
          WHERE end_ts IS NULL OR end_ts >= ?
          ORDER BY start_ts ASC`,
      )
      .all(fromTs) as Span[];
  }

  /**
   * Closes miner sessions left open by a killed process.
   *
   * Called once on boot, before anything reads a span. An open row claims
   * the miner is still running; after a SIGKILL that claim grows
   * unattended, so an 8-hour-old row would silently become 8 hours of
   * mining that never happened. The heartbeat is the last moment we know
   * it was actually up.
   *
   * Streamer sessions deliberately need no equivalent: they are keyed on
   * Twitch's stream id, so the first post-boot poll either matches the
   * row (still live, keep it open) or does not (closed by
   * closeStreamerSessionsExcept, clamped to our last evidence).
   */
  recoverOpenSessions(): void {
    this.db.exec("UPDATE miner_sessions SET end_ts = heartbeat WHERE end_ts IS NULL");
  }

  recentEvents(limit: number): EventSample[] {
    return this.db
      .prepare("SELECT ts, type, message FROM events ORDER BY ts DESC, id DESC LIMIT ?")
      .all(limit) as EventSample[];
  }
}
