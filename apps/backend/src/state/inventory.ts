import type { DropClaim } from "../db/history.js";

/**
 * How long fetched drop progress is trusted.
 *
 * Ten minutes, matching DROPS_TTL_MS and for the same reason: progress
 * moves in 30/60/120-minute steps, so a ten-minute-old bar is never
 * meaningfully stale while the call count stays sane.
 *
 * This is the idle clock. A user who wants their progress now presses
 * Refresh, which calls refresh() below and skips it.
 */
export const INVENTORY_TTL_MS = 600_000;

/**
 * Floor between two forced refetches, matching the catalogue's.
 *
 * The Drops page refresh button drives this, so the limit is what stops
 * a held button from turning one impatient user into a burst of GQL
 * calls. A refusal is not an error: the caller is served what we hold.
 */
export const INVENTORY_REFRESH_MIN_INTERVAL_MS = 60_000;

export interface DropProgressEntry {
  minutes: number;
  claimed: boolean;
  /** Set once Twitch mints an instance -- the drop is sitting there. */
  instanceId: string | null;
  /**
   * Twitch's own verdict on whether this drop's gate is open.
   *
   * `hasPreconditionsMet` from the Inventory query's self edge, which is
   * false on a drop blocked behind something watching cannot satisfy --
   * a subscription, a gift sub, an account link. The authoritative
   * signal where it exists, and the reason dropState reads it before
   * deciding a drop is merely in progress.
   *
   * Null when the source did not say: a helper predating the field, or
   * a drop with no inventory entry at all. Silence is NOT "unmet" --
   * see dropState.ts, which must never read null as blocked.
   *
   * Optional on top of nullable because a running helper from an older
   * build omits the key entirely.
   */
  preconditionsMet?: boolean | null;
}

/** campaign id -> drop id -> progress. */
export type InventoryMap = Record<
  string,
  Record<string, DropProgressEntry> | undefined
>;

/**
 * campaign id -> names of the rewards already claimed from it.
 *
 * The other half of the Inventory response, and the only thing that
 * still knows about a campaign finished and gone from the progress map
 * above -- that map's source field is `dropCampaignsInProgress`, which a
 * fully-claimed campaign leaves entirely.
 *
 * Reward NAMES rather than drop ids because the response identifies a
 * reward by item id, which is not a drop id. The catalogue's benefit
 * names are what the two sides share; dropState.ts does the matching.
 */
export type EarnedMap = Record<string, string[] | undefined>;

/** Whether a campaign's game account is linked, and where to link it. */
export interface AccountLink {
  linked: boolean;
  url: string | null;
}

/**
 * campaign id -> account link, for the campaigns Twitch told us about:
 * every one in progress, plus those running on the probed channels. An
 * absent campaign is unknown, never unlinked.
 */
export type LinkMap = Record<string, AccountLink | undefined>;

export interface InventorySnapshot {
  progress: InventoryMap;
  earned: EarnedMap;
  links: LinkMap;
  fetchedAt: number;
  /**
   * Whether the progress above can be trusted as complete.
   *
   * False after a failed fetch. Callers MUST NOT read an absent drop as
   * "not started" while this is false: a failure makes every drop
   * absent, and the two look identical from the map alone. dropState.ts
   * is where that distinction is actually applied.
   */
  available: boolean;
}

/** Enough to keep the link probe to a handful of calls. */
export const LINK_PROBE_MAX = 10;

/**
 * One channel per drop subscription for the link probe, live ones first:
 * a channel runs the campaign the subscription resolved it for, and the
 * miner reads campaigns only off live channels, so an offline one may
 * answer nothing.
 */
export function linkProbeChannels(
  config: { streamers: ReadonlyArray<{ username: string; ownedBy?: string }> },
  state: ReadonlyArray<{ username: string; channelId: string | null; isOnline: boolean | null }>,
): string[] {
  const byLogin = new Map(state.map((s) => [s.username.toLowerCase(), s]));
  const best = new Map<string, { channelId: string; live: boolean }>();
  for (const s of config.streamers) {
    if (s.ownedBy === undefined) continue;
    const known = byLogin.get(s.username.toLowerCase());
    if (known?.channelId == null) continue;
    const live = known.isOnline === true;
    const held = best.get(s.ownedBy);
    if (held === undefined || (live && !held.live)) {
      best.set(s.ownedBy, { channelId: known.channelId, live });
    }
  }
  return [...best.values()].map((b) => b.channelId).slice(0, LINK_PROBE_MAX);
}

export interface InventoryDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
  /**
   * Channel ids to ask about campaigns not yet started, read on every
   * fetch. An unlinked campaign never starts, so the inventory alone
   * cannot report it; see _links in python/helpers/state.py.
   */
  probeChannels?: () => string[];
  /** Receives every claim Twitch reports, on each fetch that could read them. */
  onClaims?: (claims: DropClaim[]) => void;
  now?: () => number;
}

/**
 * Global drop progress, on the same slow clock as DropsCache.
 *
 * Held in memory only, never persisted. Progress is a live figure whose
 * whole value is being current; reloaded from disk after a restart it
 * would describe whatever was true when the process last ran. The
 * campaign catalogue beside it makes the opposite call, deliberately --
 * its data stays true across a restart and this data does not.
 *
 * Never rejects: the Drops page must still render its campaigns when
 * progress is unavailable, just without claiming any.
 */
export class InventoryCache {
  private progress: InventoryMap = {};
  private earned: EarnedMap = {};
  private links: LinkMap = {};
  private fetchedAt = 0;
  private available = false;
  private lastRefreshAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: InventoryDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async fetch(): Promise<void> {
    if (this.inflight !== null) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await this.deps.client.request<{
          inventory: InventoryMap;
          earned?: EarnedMap;
          links?: LinkMap;
          claims?: DropClaim[] | null;
        }>("inventory", { channelIds: this.deps.probeChannels?.() ?? [] });
        this.progress = res.inventory ?? {};
        // Optional: the helper degrades this half to {} on its own
        // failure rather than losing the progress beside it, and a
        // helper predating the field omits it entirely. Either way an
        // empty map costs a finished campaign its "collected" badge --
        // the behaviour before this existed -- and nothing more.
        this.earned = res.earned ?? {};
        this.links = res.links ?? {};
        this.fetchedAt = this.now();
        this.available = true;
        if (res.claims) this.deps.onClaims?.(res.claims);
      } catch {
        // Keep the last known progress, if any -- a stale bar beats a
        // vanished one -- but stop claiming the map is complete.
        //
        // fetchedAt is deliberately not advanced: leaving it means the
        // next get() retries rather than treating the failure as a fresh
        // answer and locking the page out of progress for the full TTL.
        this.available = false;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private snapshot(): InventorySnapshot {
    return {
      progress: this.progress,
      earned: this.earned,
      links: this.links,
      fetchedAt: this.fetchedAt,
      available: this.available,
    };
  }

  async get(): Promise<InventorySnapshot> {
    const fresh =
      this.available && this.now() - this.fetchedAt < INVENTORY_TTL_MS;
    if (!fresh) await this.fetch();
    return this.snapshot();
  }

  /**
   * Refetch regardless of the TTL, for the Drops page refresh button.
   *
   * The TTL is sized for the idle case, where a ten-minute-old bar is
   * never meaningfully stale. Someone who has just finished watching is
   * not that case: they want the minutes they earned, now. Pairs with
   * CampaignCatalogue.refresh() so one press updates both halves of the
   * page rather than only the campaign list.
   *
   * Rate limited: returns what it has rather than fetching again.
   */
  async refresh(): Promise<InventorySnapshot> {
    const at = this.now();
    if (at - this.lastRefreshAt < INVENTORY_REFRESH_MIN_INTERVAL_MS) {
      return this.snapshot();
    }
    this.lastRefreshAt = at;
    await this.fetch();
    return this.snapshot();
  }
}
