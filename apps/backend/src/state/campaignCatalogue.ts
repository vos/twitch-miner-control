import { readFileSync, writeFileSync } from "node:fs";

/**
 * How long the campaign catalogue is trusted.
 *
 * Twenty-four hours, a different order of magnitude from the drops
 * progress cache beside it. Campaigns are announced days ahead and run
 * for weeks, and a drop's requiredMinutes never changes once published,
 * so the list is nearly static.
 *
 * The TTL is here to bound cost rather than staleness: there can be 100+
 * active campaigns, and fetching details for all of them on every page
 * load would spend the account's request budget on data that did not
 * move. Once a day it does not.
 */
export const CATALOGUE_TTL_MS = 86_400_000;

/**
 * Floor between manual refreshes.
 *
 * One refresh is a full detail sweep over every active campaign, so a
 * double-click would otherwise cost two.
 */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

export interface CampaignGame {
  id: string;
  slug: string;
  displayName: string;
}

export interface CampaignDrop {
  id: string;
  name: string;
  benefits: string[];
  requiredMinutes: number;
  /** Non-zero means it can never be earned by watching -- see dropState. */
  requiredSubs: number;
}

export interface Campaign {
  id: string;
  name: string;
  /** Null when the miner build's parser predates the field. */
  game: CampaignGame | null;
  startsAt: number | null;
  endsAt: number | null;
  /** Empty for an open campaign; non-empty restricts it to these channels. */
  allowChannelIds: string[];
  drops: CampaignDrop[];
}

export interface Catalogue {
  campaigns: Campaign[];
  /** Epoch ms of the fetch these campaigns came from. */
  fetchedAt: number;
  /** True when the data on hand could not be refreshed. */
  stale: boolean;
}

export interface CatalogueDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
  /** Where the catalogue is persisted across restarts. */
  path: string;
  now?: () => number;
}

interface Persisted {
  campaigns: Campaign[];
  fetchedAt: number;
}

/**
 * The drop campaign catalogue, on a 24h clock and backed by disk.
 *
 * Persisted deliberately, which is the opposite call from DropsCache
 * next door. Every field here -- a campaign's window, its game, what its
 * drops award and cost -- stays true across a restart, so reloading it
 * is honest. Progress does not have that property, and inventory.ts
 * keeps its data in memory only for exactly that reason.
 *
 * Never rejects on a failed refetch: it serves what it has and says how
 * old it is. A day-old campaign list is overwhelmingly still correct,
 * and an empty page would be the bigger lie.
 */
export class CampaignCatalogue {
  private campaigns: Campaign[] | null = null;
  private fetchedAt = 0;
  private lastRefreshAt = 0;
  private stale = false;
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: CatalogueDeps) {
    this.load();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.deps.path, "utf8")) as Persisted;
      if (Array.isArray(raw.campaigns)) {
        this.campaigns = raw.campaigns;
        this.fetchedAt = raw.fetchedAt ?? 0;
      }
    } catch {
      // No file yet, or an unparseable one. Either way the catalogue
      // starts cold and the first get() fetches -- a corrupt cache must
      // not stop the process booting.
    }
  }

  private persist(): void {
    try {
      const body: Persisted = {
        campaigns: this.campaigns ?? [],
        fetchedAt: this.fetchedAt,
      };
      writeFileSync(this.deps.path, JSON.stringify(body));
    } catch {
      // A read-only or full disk costs the restart optimisation, not the
      // feature: the in-memory copy is still serving this process.
    }
  }

  private snapshot(): Catalogue {
    return {
      campaigns: this.campaigns ?? [],
      fetchedAt: this.fetchedAt,
      stale: this.stale,
    };
  }

  private async fetch(): Promise<void> {
    // Collapse concurrent callers onto one request: two page loads must
    // not each trigger a full detail sweep.
    if (this.inflight !== null) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await this.deps.client.request<{ campaigns: Campaign[] }>(
          "campaigns",
        );
        this.campaigns = res.campaigns ?? [];
        this.fetchedAt = this.now();
        this.stale = false;
        this.persist();
      } catch {
        // Keep whatever we have and mark it old. fetchedAt is left alone
        // so the age the page shows is the age of the data, not of the
        // attempt that failed to replace it.
        this.stale = true;
        if (this.campaigns === null) this.campaigns = [];
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** The catalogue, fetching only if what we hold has expired. */
  async get(): Promise<Catalogue> {
    const fresh =
      this.campaigns !== null && this.now() - this.fetchedAt < CATALOGUE_TTL_MS;
    if (!fresh) await this.fetch();
    return this.snapshot();
  }

  /**
   * Refetch regardless of the TTL, for when a campaign has just been
   * announced and the user wants it now.
   *
   * Rate limited: returns what it has rather than sweeping again.
   */
  async refresh(): Promise<Catalogue> {
    const at = this.now();
    if (at - this.lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
      return this.snapshot();
    }
    this.lastRefreshAt = at;
    await this.fetch();
    return this.snapshot();
  }
}
