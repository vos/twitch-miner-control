import type { Profiles } from "../db/profiles.js";
import { normaliseUsername } from "./roster.js";

/**
 * How long a cached avatar URL is trusted. Streamers change their picture
 * rarely, so a week keeps the roster current at roughly one GQL call per
 * streamer per week.
 */
export const AVATAR_TTL_MS = 604_800_000;

/**
 * How long a live channel's category and viewer count are trusted.
 *
 * These ride the same GQL call as the avatar but age completely
 * differently: a week-old picture is fine, a week-old viewer count is a
 * lie. Two minutes is chosen against the 60s state poll -- it refreshes
 * every other tick, which is current enough for a figure rendered as
 * "1.2K" while still halving the calls a per-poll refresh would make.
 *
 * Only live channels are refreshed on this clock (see `resolve`), so the
 * batch is normally one or two channels rather than the whole roster.
 */
export const STREAM_TTL_MS = 120_000;

/**
 * Lookups performed in a single pass. Turning on "mine my followed
 * channels" can add fifty logins at once; fetching them all in one tick
 * would fire fifty GQL calls and put the batch at risk of NdjsonClient's
 * 30s request timeout. The remainder are picked up by later refreshes --
 * an avatar arriving a minute late costs nothing.
 */
export const MAX_FETCH_PER_PASS = 10;

/** The volatile half of a profile: true only while a channel is live. */
export interface StreamInfo {
  game: string | null;
  title: string | null;
  /** Null when the channel is offline -- 0 would claim nobody is watching. */
  viewers: number | null;
}

/** One row as the helper reports it. */
export interface ProfileRowData extends StreamInfo {
  avatarUrl: string | null;
}

export interface ProfileCacheDeps {
  profiles: Profiles;
  client: { request<T>(op: string, params?: object): Promise<T> };
  now?: () => number;
}

/**
 * Resolves avatars, categories and viewer counts, hitting Twitch only
 * for what has actually gone stale.
 *
 * One helper call serves all four fields, but they age on two different
 * clocks. The avatar is persisted and trusted for a week; the category
 * and viewer count are volatile, held in memory only, and refreshed on
 * STREAM_TTL_MS -- and then only for channels that are currently live,
 * since an offline channel has no viewer count to go stale.
 *
 * The volatile half is deliberately NOT persisted: a viewer count
 * reloaded from disk after a restart is a number that was true whenever
 * the process last ran, which is worse than having none.
 *
 * Never rejects. A refresh's balances are the dashboard's reason to
 * exist; a category is decoration, and decoration must not be able to
 * fail the thing it decorates.
 */
export class ProfileCache {
  /** Volatile fields by login. Memory only -- see the class docstring. */
  private readonly streams = new Map<string, { at: number; info: StreamInfo }>();

  constructor(private readonly deps: ProfileCacheDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * @param logins every channel to report on
   * @param live the subset currently streaming, whose volatile fields are
   *   kept current. A channel absent from this set keeps whatever stream
   *   info it last had, aged out by `resolve`'s own read.
   */
  async resolve(
    logins: string[],
    live: ReadonlySet<string> = new Set(),
  ): Promise<Map<string, ProfileRowData>> {
    const out = new Map<string, ProfileRowData>();
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
      const stream = this.streams.get(login);
      // A channel that has gone offline keeps no viewer count: the number
      // described a stream that has ended.
      const info: StreamInfo = live.has(login) && stream !== undefined
        ? stream.info
        : { game: stream?.info.game ?? null, title: stream?.info.title ?? null,
            viewers: null };

      const avatarFresh = row !== undefined && at - row.fetchedAt <= AVATAR_TTL_MS;
      // Only a live channel's volatile fields can be stale enough to be
      // worth a call -- an offline one has nothing moving to refresh.
      const streamStale = live.has(login)
        && (stream === undefined || at - stream.at > STREAM_TTL_MS);

      // Seeded with whatever we last knew. If the fetch below is capped
      // out or fails, this is what the caller gets -- a slightly old
      // category beats no category.
      out.set(login, { avatarUrl: row?.avatarUrl ?? null, ...info });
      if (!avatarFresh || streamStale) stale.push(login);
    }

    if (stale.length === 0) return out;
    const batch = stale.slice(0, MAX_FETCH_PER_PASS);

    try {
      const data = await this.deps.client.request<{
        profiles: Record<string, ProfileRowData | null>;
      }>("profiles", { streamers: batch });
      for (const login of batch) {
        // An omitted login means the helper found nothing for it. Cache
        // that as null rather than leaving no row, so it is not retried
        // on every refresh.
        const row = data.profiles?.[login] ?? null;
        const avatarUrl = row?.avatarUrl ?? null;
        this.deps.profiles.put(login, avatarUrl, at);
        const info: StreamInfo = {
          game: row?.game ?? null,
          title: row?.title ?? null,
          viewers: row?.viewers ?? null,
        };
        this.streams.set(login, { at, info });
        out.set(login, { avatarUrl, ...info });
      }
    } catch {
      // Swallowed deliberately -- see the class docstring. The seeded
      // entries above stand, and the next refresh tries again.
    }

    return out;
  }
}
