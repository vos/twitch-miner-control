import type { CampaignStart } from "../../drops/engine.js";
import type { Campaign, CampaignCatalogue } from "../../state/campaignCatalogue.js";
import { resolveCampaign } from "../../state/dropState.js";
import type { InventoryCache } from "../../state/inventory.js";
import { NOTIFY_KIND, type PublishInput } from "../catalogue.js";
import type { Notifier } from "../notifier.js";

/** The drops engine's own cadence; the catalogue and inventory are cached on it. */
export const CAMPAIGN_WATCH_MS = 15 * 60_000;
export const ENDING_SOON_MS = 24 * 3_600_000;

/** Set on the first run ever; see pass(). */
const PRIMED_KEY = "campaign.watch.primed";

const link = (id: string) => `/?open=drops&campaign=${encodeURIComponent(id)}`;
const forGame = (c: Campaign) => (c.game === null ? "" : ` for ${c.game.displayName}`);

export function campaignStartedNotification(e: CampaignStart): PublishInput {
  return {
    kind: NOTIFY_KIND.CAMPAIGN_STARTED,
    title: "Campaign started",
    body: e.why === "opened"
      ? `"${e.label}" has opened, so its channels are being mined.`
      : `"${e.label}" is next in the queue and is now being collected.`,
    link: link(e.targetId),
  };
}

export interface CampaignWatcherDeps {
  notifier: Pick<Notifier, "publish" | "wantsAny" | "markSeen">;
  catalogue: Pick<CampaignCatalogue, "get">;
  inventory: Pick<InventoryCache, "get">;
  /** Game ids the user has a game subscription for. */
  subscribedGames: () => string[];
  now?: () => number;
  intervalMs?: number;
}

/**
 * Completed, ending-soon and new campaigns.
 *
 * Covers every campaign with progress, subscribed or not, which is why
 * it watches the inventory itself rather than hooking the engine. Each
 * notification fires once per campaign, via a persisted dedupe key.
 */
export class CampaignWatcher {
  private timer: NodeJS.Timeout | null = null;
  /** Campaign ids on the previous pass; null until one has run. */
  private known: Set<string> | null = null;

  constructor(private readonly deps: CampaignWatcherDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.pass(), this.deps.intervalMs ?? CAMPAIGN_WATCH_MS);
    this.timer.unref();
    void this.pass();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async pass(): Promise<void> {
    try {
      await this.run();
    } catch {
      // The catalogue and inventory degrade on their own; a throw here
      // is retried on the next tick.
    }
  }

  private async run(): Promise<void> {
    const { notifier } = this.deps;
    const wantsDone = notifier.wantsAny(NOTIFY_KIND.CAMPAIGN_COMPLETED);
    const wantsEnding = notifier.wantsAny(NOTIFY_KIND.CAMPAIGN_ENDING_SOON);
    const wantsNew = notifier.wantsAny(NOTIFY_KIND.CAMPAIGN_NEW);
    // Without a baseline kept current, turning the kind back on would
    // announce everything that appeared meanwhile.
    if (!wantsNew) this.known = null;
    if (!wantsDone && !wantsEnding && !wantsNew) return;

    const catalogue = await this.deps.catalogue.get();
    if (!catalogue.available) return;
    const now = this.now();
    if (wantsNew) this.announceNew(catalogue.campaigns);
    if (!wantsDone && !wantsEnding) return;

    const inventory = await this.deps.inventory.get();
    if (!inventory.available) return;
    // The first run ever marks completions already there as seen, so
    // turning the kind on does not announce a backlog.
    const priming = wantsDone && notifier.markSeen(PRIMED_KEY);

    for (const campaign of catalogue.campaigns) {
      const resolved = resolveCampaign(campaign, inventory);
      if (wantsDone && resolved.complete) {
        const key = `campaign.completed:${campaign.id}`;
        if (priming) {
          notifier.markSeen(key);
        } else {
          notifier.publish({
            kind: NOTIFY_KIND.CAMPAIGN_COMPLETED, title: "Campaign complete",
            body: `Every drop in "${campaign.name}"${forGame(campaign)} is collected.`,
            link: link(campaign.id), dedupeKey: key,
          });
        }
      }
      const endsAt = campaign.endsAt;
      if (wantsEnding && resolved.status === "partial" && endsAt !== null
          && endsAt > now && endsAt - now <= ENDING_SOON_MS) {
        const hours = Math.max(1, Math.round((endsAt - now) / 3_600_000));
        notifier.publish({
          kind: NOTIFY_KIND.CAMPAIGN_ENDING_SOON, title: "Campaign ending soon",
          body: `"${campaign.name}" ends in ${hours} h with drops still unclaimed.`,
          link: link(campaign.id), dedupeKey: `campaign.endingSoon:${campaign.id}`,
        });
      }
    }
  }

  private announceNew(campaigns: readonly Campaign[]): void {
    const known = this.known;
    this.known = new Set(campaigns.map((c) => c.id));
    if (known === null) return;
    const games = new Set(this.deps.subscribedGames());
    for (const c of campaigns) {
      if (known.has(c.id) || c.game === null || !games.has(c.game.id)) continue;
      this.deps.notifier.publish({
        kind: NOTIFY_KIND.CAMPAIGN_NEW, title: "New campaign",
        body: `"${c.name}"${forGame(c)} was announced.`,
        link: link(c.id), dedupeKey: `campaign.new:${c.id}`,
      });
    }
  }
}
