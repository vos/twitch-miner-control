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
}

/** campaign id -> drop id -> progress. */
export type InventoryMap = Record<
  string,
  Record<string, DropProgressEntry> | undefined
>;

export interface InventorySnapshot {
  progress: InventoryMap;
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

export interface InventoryDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
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
        }>("inventory");
        this.progress = res.inventory ?? {};
        this.fetchedAt = this.now();
        this.available = true;
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
