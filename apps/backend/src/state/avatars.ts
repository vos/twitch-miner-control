import type { Profiles } from "../db/profiles.js";
import { normaliseUsername } from "./roster.js";

/**
 * How long a cached avatar URL is trusted. Streamers change their picture
 * rarely, so a week keeps the roster current at roughly one GQL call per
 * streamer per week.
 */
export const AVATAR_TTL_MS = 604_800_000;

/**
 * Lookups performed in a single pass. Turning on "mine my followed
 * channels" can add fifty logins at once; fetching them all in one tick
 * would fire fifty GQL calls and put the batch at risk of NdjsonClient's
 * 30s request timeout. The remainder are picked up by later refreshes --
 * an avatar arriving a minute late costs nothing.
 */
export const MAX_FETCH_PER_PASS = 10;

export interface AvatarCacheDeps {
  profiles: Profiles;
  client: { request<T>(op: string, params?: object): Promise<T> };
  now?: () => number;
}

/**
 * Resolves profile picture URLs, hitting Twitch only for logins that are
 * unknown or stale.
 *
 * Never rejects. A refresh's balances are the dashboard's reason to
 * exist; an avatar is decoration, and decoration must not be able to fail
 * the thing it decorates.
 */
export class AvatarCache {
  constructor(private readonly deps: AvatarCacheDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async resolve(logins: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    // Normalise up front so the cache keys match the roster's own dedupe
    // keys: a config entry spelled "Alpha" and a follow spelled "alpha"
    // are one channel and must share one row.
    const wanted = [...new Set(logins.map(normaliseUsername))].filter((l) => l !== "");
    if (wanted.length === 0) return out;

    const at = this.now();
    const cached = this.deps.profiles.get(wanted);
    const stale: string[] = [];

    for (const login of wanted) {
      const row = cached.get(login);
      if (row !== undefined && at - row.fetchedAt <= AVATAR_TTL_MS) {
        out.set(login, row.avatarUrl);
      } else {
        // Seed with whatever we last knew (or null). If the fetch below
        // is capped out or fails, this is what the caller gets -- a
        // slightly old picture beats no picture.
        out.set(login, row?.avatarUrl ?? null);
        stale.push(login);
      }
    }

    if (stale.length === 0) return out;
    const batch = stale.slice(0, MAX_FETCH_PER_PASS);

    try {
      const data = await this.deps.client.request<{
        avatars: Record<string, string | null>;
      }>("avatars", { streamers: batch });
      for (const login of batch) {
        // An omitted login means the helper found nothing for it. Cache
        // that as null rather than leaving no row, so it is not retried
        // on every refresh.
        const url = data.avatars?.[login] ?? null;
        this.deps.profiles.put(login, url, at);
        out.set(login, url);
      }
    } catch {
      // Swallowed deliberately -- see the class docstring. The seeded
      // entries above stand, and the next refresh tries again.
    }

    return out;
  }
}
