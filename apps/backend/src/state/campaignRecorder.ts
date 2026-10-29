import type { CampaignHistory } from "../db/campaignHistory.js";
import type { CampaignCatalogue } from "./campaignCatalogue.js";
import { resolveCampaign } from "./dropState.js";
import type { InventoryCache } from "./inventory.js";

/** The drops engine's own cadence; the catalogue and inventory are cached on it. */
export const RECORD_EVERY_MS = 15 * 60_000;

export interface CampaignRecorderDeps {
  catalogue: Pick<CampaignCatalogue, "get">;
  inventory: Pick<InventoryCache, "get">;
  store: Pick<CampaignHistory, "record">;
  now?: () => number;
  intervalMs?: number;
}

/**
 * Keeps the campaign history current while campaigns run.
 *
 * Every campaign this account has made progress on -- through this app
 * or not -- is snapshotted as it looks now, so the last one taken before
 * it leaves the catalogue is what the history keeps. Watches the
 * inventory itself rather than hooking the engine for the same reason
 * CampaignWatcher does: progress made elsewhere counts too.
 */
export class CampaignRecorder {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CampaignRecorderDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.pass(), this.deps.intervalMs ?? RECORD_EVERY_MS);
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
    const catalogue = await this.deps.catalogue.get();
    if (!catalogue.available) return;
    // Unavailable progress resolves every campaign "unknown", and a
    // snapshot of that would overwrite a real one with a blank.
    const inventory = await this.deps.inventory.get();
    if (!inventory.available) return;
    const now = this.deps.now ? this.deps.now() : Date.now();
    for (const campaign of catalogue.campaigns) {
      const resolved = resolveCampaign(campaign, inventory);
      if (resolved.status === "partial" || resolved.status === "collected") {
        this.deps.store.record(resolved, now);
      }
    }
  }
}
