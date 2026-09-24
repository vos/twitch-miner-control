import type { AppConfig } from "../config/schema.js";
import type { CampaignCatalogue } from "../state/campaignCatalogue.js";
import { resolveCampaign } from "../state/dropState.js";
import type { InventoryCache } from "../state/inventory.js";
import type { PendingRestart } from "./pendingRestart.js";
import { campaignQueue } from "./queue.js";
import { reconcile, type DesiredEntry } from "./reconcile.js";
import {
  directoryTarget,
  resolveSubscription,
  type DirectoryChannel,
} from "./resolution.js";
import { NULL_LOG, type AppLog } from "../appLog/port.js";
import { COMPONENT, EVENT } from "../appLog/types.js";

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

/**
 * How long the miner's start waits on the boot pass.
 *
 * Normally a few seconds. The budget only matters when the network is
 * slow: the miner is not held back longer than this, and a pass that
 * finishes after it has started proposes a restart like any other.
 */
export const BOOT_PASS_BUDGET_MS = 30_000;

/** A subscription that has just started collecting, for notifications. */
export interface CampaignStart {
  subscriptionId: string;
  label: string;
  targetId: string;
  /** A scheduled campaign opened, or the queue moved on to it. */
  why: "opened" | "queue";
}

export interface EngineDeps {
  loadConfig: () => AppConfig;
  saveConfig: (path: string, config: AppConfig) => void;
  configPath: string;
  catalogue: Pick<CampaignCatalogue, "get">;
  /** Live channels for a game, by display name and slug. Throws on failure. */
  directory: (game: { name: string; slug: string }) => Promise<DirectoryChannel[]>;
  pending: Pick<PendingRestart, "propose">;
  /** Drop progress, to end a subscription whose campaign is complete. */
  inventory?: Pick<InventoryCache, "get">;
  now?: () => number;
  /** Where resolution decisions are recorded, for the app event log. */
  log?: AppLog;
  /** Told when a subscription starts collecting. */
  onCampaignStarted?: (event: CampaignStart) => void;
}

/**
 * Why a pass ran.
 *
 * Recorded because it was previously unknowable: a pass that changed the
 * pool looked identical whether the timer fired it or the user had just
 * subscribed to something, and those want different reactions from
 * anyone reading back.
 */
export type PassTrigger =
  | "timer"
  | "subscribe"
  | "reorder"
  | "pool-size"
  | "remove"
  | "queue"
  | "boot"
  | "manual";

/**
 * Keeps the config's subscription-owned channels in step with intent.
 *
 * Owns no state of its own beyond the timer: every pass re-reads the
 * config, so an edit made through the UI between passes is picked up
 * rather than overwritten from a stale copy.
 */
export class SubscriptionEngine {
  private timer: NodeJS.Timeout | null = null;
  /**
   * The queue's active subscription as of the last pass, so its start is
   * logged once rather than on every pass. In memory only: after a
   * restart the current one is logged again, which is harmless.
   */
  private activeInQueue: string | null = null;
  /**
   * Subscriptions already logged as waiting for their campaign to open,
   * so that is said once and the opening can be logged when it comes.
   */
  private readonly scheduled = new Set<string>();
  /** Set once the miner has stopped waiting on the boot pass. */
  private bootLate = false;

  private readonly log: AppLog;

  constructor(private readonly deps: EngineDeps) {
    this.log = (deps.log ?? NULL_LOG).child({ component: COMPONENT.DROPS });
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.runPass("timer"), RECONCILE_INTERVAL_MS);
    // Never keep the process alive on its own account.
    this.timer.unref?.();
  }

  /**
   * The first pass, run before the miner starts.
   *
   * Acts on whatever changed while the app was down -- a campaign that
   * opened, ended or completed -- and writes it before the miner reads
   * its config, so no restart is needed to apply it. Never rejects, and
   * resolves after BOOT_PASS_BUDGET_MS at the latest; see there.
   */
  async boot(budgetMs = BOOT_PASS_BUDGET_MS): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timeout = setTimeout(() => { this.bootLate = true; resolve(); }, budgetMs);
      timeout.unref?.();
    });
    await Promise.race([this.runPass("boot"), late]);
    clearTimeout(timeout);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private runPass(trigger: PassTrigger): Promise<void> {
    return this.pass(trigger).catch((cause: unknown) => {
      // A failed pass is not fatal: the config still holds the
      // previous, working pool and the next pass tries again. It is
      // still recorded -- a pass that never completes is invisible in
      // its effects, so silence here means a pool quietly stops being
      // maintained with nothing to show for it.
      this.log.error({
        type: EVENT.PASS_FAILED,
        msg: "a resolve pass failed; the previous pool still stands and "
          + "the next pass will try again",
        err: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }

  /** One resolve-reconcile-propose cycle. Public so tests drive it. */
  async pass(trigger: PassTrigger = "manual"): Promise<void> {
    const config = this.deps.loadConfig();
    if (config.subscriptions.length === 0) {
      this.scheduled.clear();
      return;
    }

    this.log.debug({
      type: EVENT.PASS_START,
      msg: `resolving ${config.subscriptions.length} subscription(s) (${trigger})`,
      subscriptions: config.subscriptions.length,
      trigger,
    });

    const catalogue = await this.deps.catalogue.get();
    const byId = new Map(catalogue.campaigns.map((c) => [c.id, c]));
    // Only a catalogue we actually read can tell us a campaign is gone.
    const trustworthy = catalogue.available && !catalogue.stale;
    const now = this.deps.now?.() ?? Date.now();
    // Only campaign subscriptions complete, so a game-only list skips the
    // fetch. InventoryCache.get() never rejects.
    const inventory = this.deps.inventory !== undefined
      && config.subscriptions.some((s) => s.kind === "campaign")
      ? await this.deps.inventory.get()
      : null;

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
        this.log.warn({
          type: EVENT.SUBSCRIPTION_ENDED,
          msg: `campaign "${sub.label}" is gone from a fresh catalogue, so its `
            + "subscription has ended and its channels are released",
          subscriptionId: sub.id,
          label: sub.label,
          targetId: sub.targetId,
          reason: "gone",
        });
        ended.add(sub.id);
        continue;
      }

      // The tracker keeps an ended campaign listed for a while, so its
      // end date is checked too. A date read from a stale catalogue is
      // still that campaign's end date, so this needs no trustworthy test.
      if (sub.kind === "campaign" && campaign?.endsAt != null && campaign.endsAt <= now) {
        this.log.info({
          type: EVENT.SUBSCRIPTION_ENDED,
          msg: `campaign "${sub.label}" has ended, so its subscription was `
            + "removed and its channels are released",
          subscriptionId: sub.id,
          label: sub.label,
          targetId: sub.targetId,
          reason: "expired",
          endsAt: campaign.endsAt,
        });
        ended.add(sub.id);
        continue;
      }

      if (sub.kind === "campaign" && campaign !== undefined
          && inventory !== null && resolveCampaign(campaign, inventory).complete) {
        this.log.info({
          type: EVENT.SUBSCRIPTION_COMPLETED,
          msg: `campaign "${sub.label}" is 100% complete, so its subscription `
            + "was removed and its channels are released",
          subscriptionId: sub.id,
          label: sub.label,
          targetId: sub.targetId,
        });
        ended.add(sub.id);
        continue;
      }
    }

    // Worked out after the endings, so a subscription leaving on this
    // pass hands the slot straight to the next one in line.
    const queue = config.campaignQueue
      ? campaignQueue(ordered, (sub) => byId.get(sub.targetId), now, ended)
      : null;

    const active = queue === null
      ? null
      : [...queue].find(([, e]) => e.state === "active")?.[0] ?? null;

    for (const sub of ordered) {
      if (ended.has(sub.id)) continue;
      const campaign = byId.get(sub.targetId);

      const incumbents = config.streamers
        .filter((s) => s.ownedBy === sub.id)
        .map((s) => s.username);

      // Nothing can be earned before a campaign opens, so it owns no
      // channels until then -- subscribing to one adds nothing to the
      // streamer list and so proposes no restart. The first pass after
      // it opens resolves them.
      const opensAt = sub.kind === "campaign" ? campaign?.startsAt : null;
      if (opensAt != null && opensAt > now) {
        if (!this.scheduled.has(sub.id)) {
          this.scheduled.add(sub.id);
          this.log.info({
            type: EVENT.SUBSCRIPTION_SCHEDULED,
            msg: `campaign "${sub.label}" has not started yet, so it is scheduled: `
              + `its channels are added when it opens at ${new Date(opensAt).toISOString()}`,
            subscriptionId: sub.id,
            label: sub.label,
            targetId: sub.targetId,
            opensAt,
          });
        }
        continue;
      }
      if (this.scheduled.delete(sub.id)) {
        this.log.info({
          type: EVENT.SUBSCRIPTION_OPENED,
          msg: `campaign "${sub.label}" has opened, so its channels are being resolved`,
          subscriptionId: sub.id,
          label: sub.label,
          targetId: sub.targetId,
        });
        this.deps.onCampaignStarted?.({
          subscriptionId: sub.id, label: sub.label, targetId: sub.targetId, why: "opened",
        });
      }

      // A waiting subscription owns no channels, so any it held (it was
      // active before a reorder, or before the queue was turned on) are
      // released by the reconcile below.
      const place = queue?.get(sub.id);
      if (place !== undefined && place.state !== "active") continue;
      if (place?.state === "active" && this.activeInQueue !== sub.id) {
        const waiting = [...queue!.values()].filter((e) => e.state !== "active").length;
        this.log.info({
          type: EVENT.QUEUE_STARTED,
          msg: `campaign "${sub.label}" is first in the queue and is now being `
            + `collected; ${waiting} more waiting`,
          subscriptionId: sub.id,
          label: sub.label,
          targetId: sub.targetId,
          waiting,
        });
        this.deps.onCampaignStarted?.({
          subscriptionId: sub.id, label: sub.label, targetId: sub.targetId, why: "queue",
        });
      }

      const keepExisting = () => {
        for (const username of incumbents) {
          desired.push({ username, ownedBy: sub.id });
        }
      };

      const game = directoryTarget(sub, campaign);
      if (game === null) {
        this.log.warn({
          type: EVENT.DEGRADED,
          msg: `"${sub.label}" has no game to look up, so its existing `
            + `${incumbents.length} channel(s) are kept as they are`,
          subscriptionId: sub.id,
          label: sub.label,
          reason: "no-target",
          kept: incumbents.length,
        });
        keepExisting();
        continue;
      }

      let directory: DirectoryChannel[] | null = null;
      try {
        directory = await this.deps.directory(game);
      } catch (cause) {
        // Left null: resolution reports this as degraded. Caught per
        // subscription so one failing lookup does not sink the others.
        this.log.warn({
          type: EVENT.DIRECTORY_FAILED,
          msg: `the directory lookup for "${game.name}" failed`,
          subscriptionId: sub.id,
          game: game.name,
          err: cause instanceof Error ? cause.message : String(cause),
        });
      }

      const result = resolveSubscription(sub, campaign, directory, incumbents);
      if (result.degraded) {
        // Keep whatever this subscription already owns rather than
        // dropping it -- an empty pool stops collection invisibly.
        this.log.warn({
          type: EVENT.DEGRADED,
          msg: `"${sub.label}" could not be resolved (${result.decision}), so `
            + `its existing ${incumbents.length} channel(s) are kept as they are`,
          subscriptionId: sub.id,
          label: sub.label,
          reason: result.decision,
          kept: incumbents.length,
        });
        keepExisting();
        continue;
      }
      if (result.decision === "kept") {
        // The decision the pool exists to make, and the one that used to
        // be invisible: still collecting, so nothing is touched.
        this.log.info({
          type: EVENT.POOL_KEPT,
          msg: `"${sub.label}" keeps its pool: ${result.liveCount} of `
            + `${incumbents.length} channel(s) still live`,
          subscriptionId: sub.id,
          label: sub.label,
          poolSize: sub.poolSize,
          incumbents: [...incumbents],
          liveCount: result.liveCount,
        });
      } else {
        this.log.info({
          type: EVENT.POOL_REBUILT,
          msg: `"${sub.label}" has nobody live left, so its pool was rebuilt `
            + `from ${directory?.length ?? 0} live channel(s)`,
          subscriptionId: sub.id,
          label: sub.label,
          poolSize: sub.poolSize,
          from: [...incumbents],
          to: [...result.channels],
          directorySize: directory?.length ?? 0,
        });
      }
      for (const login of result.channels) {
        desired.push({ username: login, ownedBy: sub.id });
      }
    }

    this.activeInQueue = active;
    const live = new Set(ordered.filter((s) => !ended.has(s.id)).map((s) => s.id));
    for (const id of this.scheduled) if (!live.has(id)) this.scheduled.delete(id);

    const { streamers, changed, added, removed } = reconcile(config.streamers, desired);
    if (!changed && ended.size === 0) {
      // The common case by design, and deliberately debug: a healthy
      // quarter-hour where nothing needed doing should not fill the log.
      this.log.debug({
        type: EVENT.PASS_NOOP,
        msg: "the resolve pass changed nothing; no restart needed",
        trigger,
      });
      return;
    }

    this.log.info({
      type: EVENT.RECONCILED,
      msg: added.length === 0 && removed.length === 0
        ? `the watch list was reordered (${streamers.length} channel(s))`
        : `the watch list changed: +${added.length} -${removed.length}`,
      added,
      removed,
      changed,
      endedSubscriptions: ended.size,
      trigger,
    });

    this.deps.saveConfig(this.deps.configPath, {
      ...config,
      streamers,
      subscriptions: config.subscriptions.filter((s) => !ended.has(s.id)),
    });
    // The boot pass runs before the miner starts, which then reads what
    // was just written -- a restart would only repeat that start. Unless
    // it ran past its budget and the miner started without it.
    if (trigger === "boot" && !this.bootLate) return;
    this.deps.pending.propose(
      ended.size > 0
        ? "a drop campaign ended or completed"
        : "drop subscriptions resolved new channels",
    );
  }
}
