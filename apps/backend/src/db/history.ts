import type { Db } from "./schema.js";
import type { Span } from "../state/spans.js";

export interface PointSample { ts: number; balance: number }
export interface EventSample { ts: number; type: string; message: string | null }

export interface SessionRow {
  streamId: string;
  start: number;
  end: number | null;
  anchorPoints: number | null;
}

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
  lastActivity(streamer: string): EventSample | null {
    const row = this.db
      .prepare(
        "SELECT ts, type, message FROM events WHERE streamer = ? " +
          "ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(streamer) as EventSample | undefined;
    return row ?? null;
  }

  /**
   * Every attributed event for one streamer, newest first.
   *
   * lastActivity is this query with LIMIT 1. Unattributed rows
   * (streamer NULL) stay invisible here for the same reason they do
   * there: they belong to the roster-wide feed, not to a channel.
   */
  eventsFor(streamer: string, limit: number): EventSample[] {
    return this.db
      .prepare(
        "SELECT ts, type, message FROM events WHERE streamer = ? " +
          "ORDER BY ts DESC, id DESC LIMIT ?",
      )
      .all(streamer, limit) as EventSample[];
  }

  /**
   * A streamer's stream sessions, newest first, with the anchor balance
   * each one started from.
   *
   * `anchorPoints` stays null rather than defaulting: a session opened
   * before any balance was known cannot report what it earned, and zero
   * would be a confident claim that it earned nothing.
   */
  sessionsFor(streamer: string, fromTs: number): SessionRow[] {
    return this.db
      .prepare(
        `SELECT stream_id AS streamId, start_ts AS start, end_ts AS end,
                anchor_points AS anchorPoints
           FROM streamer_sessions
          WHERE streamer = ? AND (end_ts IS NULL OR end_ts >= ?)
          ORDER BY start_ts DESC`,
      )
      .all(streamer, fromTs) as SessionRow[];
  }

  /**
   * When this streamer last earned points *for watching*, or null.
   *
   * The miner's watch loop lives in the `run.py` process and never
   * publishes which channels hold its two watch slots, so this is the
   * only evidence on this side that a channel is actually being mined:
   * PubSub reports a `WATCH` reason code and the doorbell records it as
   * `GAIN_FOR_WATCH` (see vendor Twitch PubSub.py). Distinct from
   * lastActivity, which is any event -- a claim or a raid says nothing
   * about whether the miner is watching *now*.
   */
  lastWatchGain(streamer: string): number | null {
    const row = this.db
      .prepare(
        "SELECT ts FROM events WHERE streamer = ? AND type = 'GAIN_FOR_WATCH' " +
          "ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(streamer) as { ts: number } | undefined;
    return row?.ts ?? null;
  }

  /**
   * The miner's own most recent verdict on whether this channel is live.
   *
   * Upstream logs every channel's state on startup -- "is Online!" /
   * "is Offline!" -- and the doorbell records those as
   * STREAMER_ONLINE / STREAMER_OFFLINE attributed to the streamer they
   * name. The whole roster is reported within about a second of the
   * miner starting, which is well ahead of the state pass: state.py
   * issues one GQL call per streamer, sequentially.
   *
   * Returns the verdict *and* when it was made, because age is what
   * decides whether it can be trusted. A verdict has no expiry of its
   * own -- a channel offline for a week is still offline -- but the
   * miner only keeps it current while it is running, so a row left by a
   * miner that has since stopped can be arbitrarily old. The caller
   * bounds it; see LIVENESS_TRUST_MS in state/service.ts.
   */
  lastLiveness(streamer: string): { online: boolean; ts: number } | null {
    const row = this.db
      .prepare(
        "SELECT ts, type FROM events WHERE streamer = ? " +
          "AND type IN ('STREAMER_ONLINE', 'STREAMER_OFFLINE') " +
          "ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(streamer) as { ts: number; type: string } | undefined;
    if (row === undefined) return null;
    return { online: row.type === "STREAMER_ONLINE", ts: row.ts };
  }

  /**
   * When the streamer's currently-open stream started, or null if none.
   *
   * The card counts its uptime from this. Read only alongside a fresh
   * liveness verdict: an open row on its own survives the backend
   * stopping, so it says "we never saw this stream end", not "this
   * stream is running".
   */
  openStreamerSessionStart(streamer: string): number | null {
    const row = this.db
      .prepare(
        "SELECT start_ts FROM streamer_sessions WHERE streamer = ? AND end_ts IS NULL " +
          "ORDER BY start_ts DESC LIMIT 1",
      )
      .get(streamer) as { start_ts: number } | undefined;
    return row?.start_ts ?? null;
  }

  /**
   * Records the first sighting of a stream. Idempotent per stream.
   *
   * `ON CONFLICT DO NOTHING` is what makes this restart-proof. It is
   * called on every tick a streamer is live, not on an observed
   * transition, so the second and thousandth sighting of the same stream
   * must leave the row -- and crucially its anchor balance -- untouched.
   *
   * Returns whether this sighting inserted the row: true exactly once per
   * stream, which is what makes it a restart-proof "went live" signal.
   */
  openStreamerSession(
    streamer: string,
    streamId: string,
    startTs: number,
    anchorPoints: number | null,
  ): boolean {
    return this.db
      .prepare(
        `INSERT INTO streamer_sessions (streamer, stream_id, start_ts, anchor_points)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (streamer, stream_id) DO NOTHING`,
      )
      .run(streamer, streamId, startTs, anchorPoints).changes === 1;
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

  /**
   * Every streamer's snapshots in `[fromTs, toTs)`, grouped by streamer
   * and oldest first within each: the input to a day's rollup.
   */
  samplesBetween(fromTs: number, toTs: number): { streamer: string; ts: number; balance: number }[] {
    return this.db
      .prepare(
        `SELECT streamer, ts, balance FROM point_snapshots
          WHERE ts >= ? AND ts < ? ORDER BY streamer, ts, id`,
      )
      .all(fromTs, toTs) as { streamer: string; ts: number; balance: number }[];
  }

  /**
   * The balance in force just before `ts`: the latest snapshot strictly
   * earlier. Strict, unlike balanceAt, because a snapshot landing exactly
   * at midnight belongs to the day it opens, not to the one before.
   */
  balanceBefore(streamer: string, ts: number): number | null {
    const row = this.db
      .prepare(
        "SELECT balance FROM point_snapshots WHERE streamer = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(streamer, ts) as { balance: number } | undefined;
    return row ? row.balance : null;
  }

  /** The oldest snapshot anyone still has, or null: where a rollup starts. */
  earliestSampleTs(): number | null {
    const row = this.db
      .prepare("SELECT MIN(ts) AS ts FROM point_snapshots")
      .get() as { ts: number | null };
    return row.ts;
  }

  /** Every channel's online spans overlapping `fromTs` onward, oldest first. */
  allStreamerSpans(fromTs: number): { streamer: string; start: number; end: number | null }[] {
    return this.db
      .prepare(
        `SELECT streamer, start_ts AS start, end_ts AS end FROM streamer_sessions
          WHERE end_ts IS NULL OR end_ts >= ?
          ORDER BY start_ts ASC`,
      )
      .all(fromTs) as { streamer: string; start: number; end: number | null }[];
  }

  /**
   * How many events of each asked-for type landed in `[fromTs, toTs)`.
   * Every asked-for type is in the result, at zero when none landed.
   */
  countEvents(types: readonly string[], fromTs: number, toTs: number): Record<string, number> {
    const out: Record<string, number> = Object.fromEntries(types.map((t) => [t, 0]));
    if (types.length === 0) return out;
    const holes = types.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT type, COUNT(*) AS n FROM events
          WHERE ts >= ? AND ts < ? AND type IN (${holes}) GROUP BY type`,
      )
      .all(fromTs, toTs, ...types) as { type: string; n: number }[];
    for (const row of rows) out[row.type] = row.n;
    return out;
  }

  /**
   * Deletes point snapshots older than `olderThan`. Returns rows removed.
   *
   * Only this table is pruned: it is the one that grows per tick. The
   * session tables are tiny and back the all-time mining figure, so
   * dropping rows from them would corrupt it.
   */
  prunePoints(olderThan: number): number {
    return this.db
      .prepare("DELETE FROM point_snapshots WHERE ts < ?")
      .run(olderThan).changes;
  }

  recentEvents(limit: number): EventSample[] {
    return this.db
      .prepare("SELECT ts, type, message FROM events ORDER BY ts DESC, id DESC LIMIT ?")
      .all(limit) as EventSample[];
  }
}
