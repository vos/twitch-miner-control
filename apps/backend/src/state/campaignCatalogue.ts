import { readFileSync, writeFileSync } from "node:fs";
import { fetchCampaigns } from "./campaignSource.js";
import { NULL_LOG, type AppLog } from "../appLog/port.js";
import { COMPONENT, EVENT } from "../appLog/types.js";

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
  /**
   * Twitch box art for the category, or null when the source had none.
   *
   * Optional on top of nullable because the catalogue below is persisted
   * as raw JSON with no migration: for up to a TTL after an upgrade,
   * campaigns load from disk without the fields the build now expects.
   * Every reader has to treat absent and null alike.
   */
  boxArtUrl?: string | null;
}

/** One award from a drop: what it is called, and what it looks like. */
export interface CampaignBenefit {
  name: string;
  imageUrl: string | null;
}

export interface CampaignDrop {
  id: string;
  name: string;
  benefits: CampaignBenefit[];
  requiredMinutes: number;
  /**
   * Non-zero means it can never be earned by watching -- see dropState.
   *
   * Always 0 from the current source, which never sets the field it is
   * derived from; dropState has two further signals for these drops.
   */
  requiredSubs: number;
  /**
   * The drop's own window, which can be narrower than its campaign's.
   *
   * Absent on a catalogue written before these were parsed; see
   * CampaignGame.boxArtUrl.
   */
  startsAt?: number | null;
  endsAt?: number | null;
}

/** Who runs the campaign -- a studio or publisher, shown on the card. */
export interface CampaignOwner {
  name: string;
  type: string;
}

export interface Campaign {
  id: string;
  name: string;
  /** Null when the miner build's parser predates the field. */
  game: CampaignGame | null;
  /** Absent on a catalogue written before this was parsed. */
  owner?: CampaignOwner | null;
  startsAt: number | null;
  endsAt: number | null;
  drops: CampaignDrop[];
}

export interface Catalogue {
  campaigns: Campaign[];
  /** Epoch ms of the fetch these campaigns came from. */
  fetchedAt: number;
  /** True when the data on hand could not be refreshed. */
  stale: boolean;
  /**
   * Whether we have ever successfully read the campaign list.
   *
   * False means the list below is empty because we could not fetch it,
   * not because no campaigns are running -- a distinction the UI has to
   * make, or it reports a failed source as "no drop campaigns", which is
   * a confident claim about Twitch that we are in no position to make.
   */
  available: boolean;
  /** Why the last fetch failed, for the page to show. Null when fine. */
  error: string | null;
}

export interface CatalogueDeps {
  /**
   * Fetches every tracked campaign, throwing on any failure.
   *
   * Defaults to the public tracker in campaignSource.ts. Injectable so
   * tests drive it without a network, and so the source can be swapped
   * without touching the caching around it.
   */
  source?: () => Promise<Campaign[]>;
  /** Where the catalogue is persisted across restarts. */
  path: string;
  now?: () => number;
  /**
   * Where fetch outcomes are recorded.
   *
   * A stale catalogue is what makes the drops engine stop trusting
   * absence as an ending, so it explains decisions taken elsewhere --
   * which is exactly the kind of cross-system link a single log exists
   * to make visible.
   */
  log?: AppLog;
}

/**
 * A campaign as some earlier build may have written it.
 *
 * Only the fields whose shape changed are restated; everything else is
 * either unchanged or already optional. `migrate` narrows this back to a
 * Campaign on load.
 */
type PersistedCampaign = Omit<Campaign, "drops"> & {
  drops: (Omit<CampaignDrop, "benefits"> & {
    benefits?: CampaignDrop["benefits"] | string[];
  })[];
};

interface Persisted {
  campaigns: PersistedCampaign[];
  fetchedAt: number;
}

/**
 * Brings a campaign read off disk up to the shape this build expects.
 *
 * The cache is raw JSON with a 24h TTL and no version stamp, so for up
 * to a day after an upgrade this process serves campaigns written by the
 * previous one. The shape that actually changed is `benefits`, once a
 * list of names and now a list of objects -- left alone, every reward
 * tile would render a nameless placeholder until the TTL expired.
 *
 * Widening the field's type instead would push this same check into
 * every consumer and leave the old shape live in the API payload. One
 * conversion at the boundary keeps the rest of the app honest about what
 * a benefit is.
 */
function migrate(campaign: PersistedCampaign): Campaign {
  return {
    ...campaign,
    drops: campaign.drops.map((drop) => ({
      ...drop,
      benefits: (drop.benefits ?? []).map((benefit) =>
        typeof benefit === "string"
          ? { name: benefit, imageUrl: null }
          : benefit,
      ),
    })),
  };
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
  private error: string | null = null;
  private inflight: Promise<void> | null = null;
  private readonly source: () => Promise<Campaign[]>;
  private readonly log: AppLog;

  constructor(private readonly deps: CatalogueDeps) {
    this.source = deps.source ?? (() => fetchCampaigns());
    this.log = (deps.log ?? NULL_LOG).child({ component: COMPONENT.CATALOGUE });
    this.load();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.deps.path, "utf8")) as Persisted;
      if (Array.isArray(raw.campaigns)) {
        this.campaigns = raw.campaigns.map(migrate);
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
      // Campaigns loaded from disk count: they were fetched successfully
      // once, and their age is reported beside them.
      available: this.campaigns !== null && this.fetchedAt > 0,
      error: this.error,
    };
  }

  private async fetch(): Promise<void> {
    // Collapse concurrent callers onto one request: two page loads must
    // not each trigger a full detail sweep.
    if (this.inflight !== null) return this.inflight;
    this.inflight = (async () => {
      try {
        this.campaigns = await this.source();
        this.fetchedAt = this.now();
        this.stale = false;
        this.error = null;
        this.persist();
        this.log.info({
          type: EVENT.CATALOGUE_FETCHED,
          msg: `fetched ${this.campaigns.length} active campaign(s)`,
          campaigns: this.campaigns.length,
        });
      } catch (cause: unknown) {
        // Keep whatever we have and mark it old. fetchedAt is left alone
        // so the age the page shows is the age of the data, not of the
        // attempt that failed to replace it.
        //
        // The source throws rather than returning [] precisely so this
        // lands here: an empty list must never be mistaken for the fact
        // that no campaigns are running.
        this.stale = true;
        this.error = cause instanceof Error ? cause.message : String(cause);
        this.log.warn({
          type: EVENT.CATALOGUE_STALE,
          msg: `the campaign fetch failed (${this.error}); serving the `
            + "previous list, and no subscription will be ended from it",
          err: this.error,
          fetchedAt: this.fetchedAt,
          ageMs: this.fetchedAt === 0 ? null : this.now() - this.fetchedAt,
        });
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /**
   * What is held right now, without fetching. Null before anything is.
   *
   * For synchronous readers that cannot await -- the owner lookup on a
   * streamer card runs on every derivation and only wants a name. They
   * get the disk copy loaded at construction, or whatever the last
   * fetch left; staleness does not matter for a game name, which does
   * not change for the life of a campaign.
   */
  peek(): Catalogue | null {
    return this.campaigns === null ? null : this.snapshot();
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
