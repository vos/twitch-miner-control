import type { Db } from "./schema.js";

export interface ProfileRow {
  login: string;
  avatarUrl: string | null;
  fetchedAt: number;
}

/**
 * The cached Twitch profile picture URL for each known login.
 *
 * Separate from `History` because that class owns points and events --
 * time series that grow forever -- while this is a small key/value cache
 * with a completely different lifecycle.
 */
export class Profiles {
  constructor(private readonly db: Db) {}

  get(logins: string[]): Map<string, ProfileRow> {
    const out = new Map<string, ProfileRow>();
    // An empty IN () is a SQL syntax error, and there is nothing to ask
    // for anyway.
    if (logins.length === 0) return out;
    const holes = logins.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT login, avatar_url, fetched_at
           FROM streamer_profiles WHERE login IN (${holes})`,
      )
      .all(...logins) as { login: string; avatar_url: string | null; fetched_at: number }[];
    for (const row of rows) {
      out.set(row.login, {
        login: row.login,
        avatarUrl: row.avatar_url,
        fetchedAt: row.fetched_at,
      });
    }
    return out;
  }

  put(login: string, avatarUrl: string | null, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO streamer_profiles (login, avatar_url, fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(login) DO UPDATE SET avatar_url = excluded.avatar_url,
                                          fetched_at = excluded.fetched_at`,
      )
      .run(login, avatarUrl, ts);
  }
}
