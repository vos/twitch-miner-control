import type { AppConfig } from "../config/schema.js";
import type { CampaignCatalogue } from "../state/campaignCatalogue.js";
import type { PendingRestart } from "./pendingRestart.js";
import { reconcile, type DesiredEntry } from "./reconcile.js";
import {
  directoryTarget,
  resolveSubscription,
  type DirectoryChannel,
} from "./resolution.js";

/**
 * How often subscriptions are re-resolved.
 *
 * Fifteen minutes. This is the cadence at which a WHOLE pool can go
 * stale, not the cadence at which individual channels go offline -- a
 * pool keeping even one live member is left untouched by a pass, so
 * members going offline cost nothing until the last one does. Well under
 * the shortest meaningful drop (30 minutes), so even a completely dead
 * pool costs at most half a drop's progress.
 */
export const RECONCILE_INTERVAL_MS = 900_000;

export interface EngineDeps {
  loadConfig: () => AppConfig;
  saveConfig: (path: string, config: AppConfig) => void;
  configPath: string;
  catalogue: Pick<CampaignCatalogue, "get">;
  /** Live channels for a game, by display name and slug. Throws on failure. */
  directory: (game: { name: string; slug: string }) => Promise<DirectoryChannel[]>;
  pending: Pick<PendingRestart, "propose">;
}

/**
 * Keeps the config's subscription-owned channels in step with intent.
 *
 * Owns no state of its own beyond the timer: every pass re-reads the
 * config, so an edit made through the UI between passes is picked up
 * rather than overwritten from a stale copy.
 */
export class SubscriptionEngine {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: EngineDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.pass().catch(() => {
        // A failed pass is not fatal: the config still holds the
        // previous, working pool and the next pass tries again.
      });
    }, RECONCILE_INTERVAL_MS);
    // Never keep the process alive on its own account.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One resolve-reconcile-propose cycle. Public so tests drive it. */
  async pass(): Promise<void> {
    const config = this.deps.loadConfig();
    if (config.subscriptions.length === 0) return;

    const catalogue = await this.deps.catalogue.get();
    const byId = new Map(catalogue.campaigns.map((c) => [c.id, c]));
    // Only a catalogue we actually read can tell us a campaign is gone.
    const trustworthy = catalogue.available && !catalogue.stale;

    // Rank order: lower ranks fill the miner's watch slots first, and
    // the written order is what upstream's priority_order consumes.
    const ordered = [...config.subscriptions].sort((a, b) => a.rank - b.rank);

    const desired: DesiredEntry[] = [];
    const ended = new Set<string>();

    for (const sub of ordered) {
      const campaign = byId.get(sub.targetId);

      // A campaign subscription whose campaign is missing from a
      // trustworthy catalogue has ended: the catalogue holds active
      // campaigns only, so absence is the end signal. Absence from a
      // stale or unavailable one means we could not look, and treating
      // that as an ending would delete a live subscription over a
      // network blip. Game subscriptions are never ended this way --
      // they are not tied to any one campaign's lifetime.
      if (sub.kind === "campaign" && campaign === undefined && trustworthy) {
        ended.add(sub.id);
        continue;
      }

      const incumbents = config.streamers
        .filter((s) => s.ownedBy === sub.id)
        .map((s) => s.username);

      const keepExisting = () => {
        for (const username of incumbents) {
          desired.push({ username, ownedBy: sub.id });
        }
      };

      const game = directoryTarget(sub, campaign);
      if (game === null) {
        keepExisting();
        continue;
      }

      let directory: DirectoryChannel[] | null = null;
      try {
        directory = await this.deps.directory(game);
      } catch {
        // Left null: resolution reports this as degraded. Caught per
        // subscription so one failing lookup does not sink the others.
      }

      const result = resolveSubscription(sub, campaign, directory, incumbents);
      if (result.degraded) {
        // Keep whatever this subscription already owns rather than
        // dropping it -- an empty pool stops collection invisibly.
        keepExisting();
        continue;
      }
      for (const login of result.channels) {
        desired.push({ username: login, ownedBy: sub.id });
      }
    }

    const { streamers, changed } = reconcile(config.streamers, desired);
    if (!changed && ended.size === 0) return;

    this.deps.saveConfig(this.deps.configPath, {
      ...config,
      streamers,
      subscriptions: config.subscriptions.filter((s) => !ended.has(s.id)),
    });
    this.deps.pending.propose(
      ended.size > 0
        ? "a drop campaign ended"
        : "drop subscriptions resolved new channels",
    );
  }
}
