import type { Db } from "./schema.js";

export interface StreamerRow {
  login: string;
  firstSeenTs: number | null;
  lastSeenTs: number | null;
  displayName: string | null;
  avatarUrl: string | null;
  fetchedAt: number | null;
}

/**
 * One row per channel we know about: when we first saw it, when we last
 * saw it, its Twitch capitalisation, and its cached avatar.
 *
 * Separate from `History`, which owns points and events -- time series
 * that grow per tick. This is a small key/value table with one row per
 * streamer and a completely different lifecycle: it is never pruned,
 * because `first_seen_ts` is the floor under the all-time mining figure
 * and losing it would silently inflate that figure back to the stream's
 * own length.
 */
export class Streamers {
  constructor(private readonly db: Db) {}

  /**
   * Records that the state pass saw this channel at `ts`.
   *
   * The first sighting is written once and never moved: it is the
   * "since when were we watching" clock, and a later poll overwriting it
   * would restart every mining figure from zero on every tick. The
   * `MIN` guard also keeps an out-of-order write from moving the floor
   * forward, so the earliest sighting always wins.
   *
   * `displayName` is only overwritten when this poll actually carried
   * one: state.py reports NULL for a channel whose community block is
   * missing, and letting that null win would rename the card to its
   * lowercase login until the next good poll. A genuine rename still
   * takes effect, because a non-null name always wins.
   */
  see(login: string, ts: number, displayName: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO streamers (login, first_seen_ts, last_seen_ts, display_name)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(login) DO UPDATE SET
           first_seen_ts = MIN(COALESCE(first_seen_ts, excluded.first_seen_ts),
                               excluded.first_seen_ts),
           last_seen_ts  = MAX(COALESCE(last_seen_ts, excluded.last_seen_ts),
                               excluded.last_seen_ts),
           display_name  = COALESCE(excluded.display_name, display_name)`,
      )
      .run(login, ts, ts, displayName);
  }

  /** When we first polled this channel, or null if the state pass never has. */
  firstSeen(login: string): number | null {
    const row = this.db
      .prepare("SELECT first_seen_ts FROM streamers WHERE login = ?")
      .get(login) as { first_seen_ts: number | null } | undefined;
    return row?.first_seen_ts ?? null;
  }

  /**
   * Caches the avatar. Deliberately does not touch the sighting columns:
   * this runs on the profile pass, which is a different clock and is no
   * evidence that we have watched the channel.
   */
  putProfile(login: string, avatarUrl: string | null, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO streamers (login, avatar_url, fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(login) DO UPDATE SET avatar_url = excluded.avatar_url,
                                          fetched_at = excluded.fetched_at`,
      )
      .run(login, avatarUrl, ts);
  }

  get(logins: string[]): Map<string, StreamerRow> {
    const out = new Map<string, StreamerRow>();
    // An empty IN () is a SQL syntax error, and there is nothing to ask
    // for anyway.
    if (logins.length === 0) return out;
    const holes = logins.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT login, first_seen_ts, last_seen_ts, display_name,
                avatar_url, fetched_at
           FROM streamers WHERE login IN (${holes})`,
      )
      .all(...logins) as {
        login: string;
        first_seen_ts: number | null;
        last_seen_ts: number | null;
        display_name: string | null;
        avatar_url: string | null;
        fetched_at: number | null;
      }[];
    for (const row of rows) {
      out.set(row.login, {
        login: row.login,
        firstSeenTs: row.first_seen_ts,
        lastSeenTs: row.last_seen_ts,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        fetchedAt: row.fetched_at,
      });
    }
    return out;
  }
}
