import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config/schema.js";
import type { CampaignCatalogue } from "../state/campaignCatalogue.js";
import { resolveCampaign } from "../state/dropState.js";
import type { InventoryCache, InventorySnapshot } from "../state/inventory.js";
import type { Campaign } from "../state/campaignCatalogue.js";
import type { PendingRestart } from "./pendingRestart.js";
import { followGames, recordSkipped } from "./follow.js";
import { campaignQueue } from "./queue.js";
import { rebasePass } from "./rebase.js";
import { reconcile, type DesiredEntry } from "./reconcile.js";
import {
  directoryTarget,
  rankDirectory,
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
 * How long a live pool's campaign may sit still before the pool is replaced.
 *
 * Three passes. Progress is read from an inventory up to ten minutes old,
 * so this is at least half an hour of nothing, and a watched channel
 * that carries the campaign moves it every minute.
 */
export const STALL_AFTER_MS = 2_700_000;

/**
 * How many rebuild candidates are asked which campaigns they run.
 *
 * One query per channel, best first, so this bounds a rebuild's cost
 * while still reaching past the top few when they run something else.
 */
export const CAMPAIGN_CHECK_LIMIT = 10;

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

/** A campaign a followed game subscribed to, for notifications. */
export interface CampaignFollowed {
  subscriptionId: string;
  label: string;
  targetId: string;
  /** The followed game's name. */
  game: string;
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
  /**
   * Told when a followed game subscribes to a campaign, except for games
   * the pass was asked to keep quiet about.
   */
  onCampaignFollowed?: (event: CampaignFollowed) => void;
  /** New subscription ids. Injectable so tests get stable ones. */
  newId?: () => string;
  /**
   * The campaign ids each channel runs, by channel id; null for one that
   * could not be read. Throws when the lookup fails as a whole.
   */
  channelCampaigns?: (channelIds: string[]) => Promise<Record<string, string[] | null>>;
  /** Whether the miner is running, without which no campaign can progress. */
  minerRunning?: () => boolean;
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
  | "manual"
  | "follow"
  | "unskip";

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
  /**
   * The drop-slot subscription's progress when it last moved, and the
   * pool it had then. In memory only: a restart starts the clock again.
   */
  private readonly progress = new Map<string, { pool: string; minutes: number; since: number }>();
  /** Lowercase logins each subscription's rebuilds pass over: they stalled. */
  private readonly stalled = new Map<string, Set<string>>();

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
  async pass(
    trigger: PassTrigger = "manual",
    options: {
      /**
       * Games whose campaigns are added without being announced: the ones
       * the user has just followed, and is looking at the result of.
       */
      quietGames?: ReadonlySet<string>;
      /** Rebuild every pool, even one with a live member: the user asked. */
      rebuild?: boolean;
    } = {},
  ): Promise<void> {
    const loaded = this.deps.loadConfig();
    if (loaded.subscriptions.length === 0 && loaded.followedGames.length === 0) {
      this.scheduled.clear();
      return;
    }

    this.log.debug({
      type: EVENT.PASS_START,
      msg: `resolving ${loaded.subscriptions.length} subscription(s) (${trigger})`,
      subscriptions: loaded.subscriptions.length,
      trigger,
    });

    const catalogue = await this.deps.catalogue.get();
    const byId = new Map(catalogue.campaigns.map((c) => [c.id, c]));
    // Only a catalogue we actually read can tell us a campaign is gone.
    const trustworthy = catalogue.available && !catalogue.stale;
    const now = this.deps.now?.() ?? Date.now();
    // InventoryCache.get() never rejects.
    const inventory = this.deps.inventory !== undefined
      ? await this.deps.inventory.get()
      : null;

    // Before anything else, so a campaign a followed game adds gets its
    // channels on this same pass.
    const follow = followGames(
      loaded, catalogue, inventory, now, this.deps.newId ?? randomUUID,
    );
    const config = follow.changed
      ? {
        ...loaded,
        followedGames: follow.followedGames,
        subscriptions: [...loaded.subscriptions, ...follow.added.map((a) => a.subscription)],
      }
      : loaded;
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
      // network blip.
      if (campaign === undefined && trustworthy) {
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
      if (campaign?.endsAt != null && campaign.endsAt <= now) {
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

      if (campaign !== undefined && inventory !== null && resolveCampaign(campaign, inventory).complete) {
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
    // Only the first live pool in rank order holds the miner's drop slot
    // (see DropSlotSelector in python/miner_config.py), so only its
    // progress says anything about its channels.
    let slotTaken = false;
    const judged = new Set<string>();

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
      const opensAt = campaign?.startsAt;
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

      const game = directoryTarget(campaign);
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

      let result = resolveSubscription(sub, campaign, directory, incumbents);
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
      const holdsSlot = !slotTaken;
      let reason: "empty" | "manual" | "stalled" = "empty";
      if (result.decision === "kept") {
        if (options.rebuild === true) {
          reason = "manual";
        } else if (holdsSlot) {
          judged.add(sub.id);
          if (this.stalledNow(sub, campaign, inventory, incumbents, now)) reason = "stalled";
        }
      }
      if (result.decision === "rebuilt" || reason !== "empty") {
        const exclude = this.stalled.get(sub.id);
        // Not degraded, so the directory was read.
        const check = await this.campaignCheck(sub, directory!, exclude);
        result = resolveSubscription(sub, campaign, directory, incumbents, {
          rebuild: true, exclude, carries: check?.carries,
        });
        this.log.info({
          type: EVENT.POOL_REBUILT,
          msg: `"${sub.label}" ${REBUILD_WHY[reason]}, so its pool was rebuilt `
            + `from ${directory?.length ?? 0} live channel(s)`,
          subscriptionId: sub.id,
          label: sub.label,
          reason,
          poolSize: sub.poolSize,
          from: [...incumbents],
          to: [...result.channels],
          directorySize: directory?.length ?? 0,
          checked: check?.checked ?? 0,
          carrying: check?.carrying ?? 0,
        });
      } else {
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
      }
      if (result.channels.length > 0) slotTaken = true;
      for (const login of result.channels) {
        desired.push({ username: login, ownedBy: sub.id });
      }
    }

    this.activeInQueue = active;
    const live = new Set(ordered.filter((s) => !ended.has(s.id)).map((s) => s.id));
    for (const id of this.scheduled) if (!live.has(id)) this.scheduled.delete(id);
    // A subscription that lost the slot starts its clock afresh when it
    // gets it back, rather than being judged on the time it waited.
    for (const id of this.progress.keys()) if (!judged.has(id)) this.progress.delete(id);
    for (const id of this.stalled.keys()) if (!live.has(id)) this.stalled.delete(id);

    const { changed } = reconcile(config.streamers, desired);
    // A leaving campaign of a followed game is filed as skipped, so the
    // game does not add it back while it is still listed -- say on a
    // pass where progress could not be read to show it complete.
    const followedGames = ended.size === 0
      ? config.followedGames
      : recordSkipped(
        config.followedGames,
        ordered.filter((s) => ended.has(s.id)),
        (id) => byId.get(id)?.game?.id,
      );
    if (!changed && ended.size === 0 && !follow.changed) {
      // The common case by design, and deliberately debug: a healthy
      // quarter-hour where nothing needed doing should not fill the log.
      this.log.debug({
        type: EVENT.PASS_NOOP,
        msg: "the resolve pass changed nothing; no restart needed",
        trigger,
      });
      return;
    }

    // Applied to the config as it is now, not as this pass read it: a
    // route may have saved while the pass was asking Twitch.
    const { config: next, reconciliation } = rebasePass(this.deps.loadConfig(), {
      ended,
      added: follow.added.map((a) => a.subscription),
      considered: new Set(ordered.map((s) => s.id)),
      desired,
      gamesBefore: loaded.followedGames,
      gamesAfter: followedGames,
    });
    const { streamers, added, removed } = reconciliation;
    if (reconciliation.changed || ended.size > 0) {
      this.log.info({
        type: EVENT.RECONCILED,
        msg: added.length === 0 && removed.length === 0
          ? `the watch list was reordered (${streamers.length} channel(s))`
          : `the watch list changed: +${added.length} -${removed.length}`,
        added,
        removed,
        changed: reconciliation.changed,
        endedSubscriptions: ended.size,
        trigger,
      });
    }

    this.deps.saveConfig(this.deps.configPath, next);
    const saved = new Set(next.subscriptions.map((s) => s.id));
    // After the save, and only for what it kept: an addition dropped
    // because its game was unfollowed meanwhile never happened.
    for (const { subscription, game } of follow.added) {
      if (!saved.has(subscription.id)) continue;
      this.log.info({
        type: EVENT.SUBSCRIPTION_FOLLOWED,
        msg: `"${subscription.label}" is a campaign for followed game "${game.name}", `
          + "so it was subscribed to",
        subscriptionId: subscription.id,
        label: subscription.label,
        targetId: subscription.targetId,
        game: game.name,
      });
      if (options.quietGames?.has(game.id)) continue;
      this.deps.onCampaignFollowed?.({
        subscriptionId: subscription.id,
        label: subscription.label,
        targetId: subscription.targetId,
        game: game.name,
      });
    }
    // Only a different watch list needs the miner restarted; a campaign
    // added but not open yet changes nothing it can see.
    if (!reconciliation.changed && ended.size === 0) return;
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

  /**
   * Whether the drop-slot subscription's campaign has sat still too long.
   *
   * Judged only when it could have moved: the miner running, progress
   * read, and a drop open that watching can earn. Anything else forgets
   * the clock, so a pause is never counted as a stall.
   */
  private stalledNow(
    sub: { id: string; label: string; targetId: string },
    campaign: Campaign | undefined,
    inventory: InventorySnapshot | null,
    incumbents: readonly string[],
    now: number,
  ): boolean {
    const minutes = this.deps.minerRunning?.() === false
      ? null
      : earnableMinutes(campaign, inventory, now);
    if (minutes === null) {
      this.progress.delete(sub.id);
      return false;
    }
    const pool = incumbents.map((l) => l.toLowerCase()).sort().join(",");
    const seen = this.progress.get(sub.id);
    if (seen === undefined || seen.pool !== pool || minutes > seen.minutes) {
      this.progress.set(sub.id, { pool, minutes, since: now });
      return false;
    }
    if (now - seen.since < STALL_AFTER_MS) return false;

    // The clock starts over, so a rebuild that finds nobody better is
    // logged once per period rather than on every pass.
    this.progress.set(sub.id, { pool, minutes, since: now });
    const excluded = this.stalled.get(sub.id) ?? new Set<string>();
    for (const login of incumbents) excluded.add(login.toLowerCase());
    this.stalled.set(sub.id, excluded);
    this.log.warn({
      type: EVENT.SUBSCRIPTION_STALLED,
      msg: `"${sub.label}" has not progressed in ${Math.round((now - seen.since) / 60_000)} `
        + "minutes although its pool is live, so its channels are being replaced",
      subscriptionId: sub.id,
      label: sub.label,
      targetId: sub.targetId,
      channels: [...incumbents],
      minutes,
      since: seen.since,
    });
    return true;
  }

  /**
   * Asks Twitch which campaigns the best rebuild candidates run.
   *
   * Undefined when it cannot be asked or the lookup fails: the rebuild
   * then ranks the directory alone, as it did before this existed.
   */
  private async campaignCheck(
    sub: { id: string; targetId: string },
    directory: DirectoryChannel[],
    exclude: ReadonlySet<string> | undefined,
  ): Promise<{ carries: Map<string, boolean>; checked: number; carrying: number } | undefined> {
    if (this.deps.channelCampaigns === undefined) return undefined;
    const candidates = rankDirectory(directory, exclude).slice(0, CAMPAIGN_CHECK_LIMIT);
    if (candidates.length === 0) return undefined;
    let runs: Record<string, string[] | null>;
    try {
      runs = await this.deps.channelCampaigns(candidates.map((c) => c.channelId));
    } catch (cause) {
      this.log.warn({
        type: EVENT.CAMPAIGN_CHECK_FAILED,
        msg: "could not ask which campaigns the candidate channels run, so "
          + "the pool is ranked by viewers alone",
        subscriptionId: sub.id,
        err: cause instanceof Error ? cause.message : String(cause),
      });
      return undefined;
    }
    const carries = new Map<string, boolean>();
    for (const c of candidates) {
      const ids = runs[c.channelId];
      if (ids != null) carries.set(c.login.toLowerCase(), ids.includes(sub.targetId));
    }
    return {
      carries,
      checked: carries.size,
      carrying: [...carries.values()].filter(Boolean).length,
    };
  }
}

/** How each rebuild reason reads in the log. */
const REBUILD_WHY = {
  empty: "has nobody live left",
  manual: "was re-resolved by hand",
  stalled: "stopped progressing",
} as const;

/**
 * Minutes watched across a campaign's drops, or null when watching
 * could not move them now: progress unread, or no drop open that is
 * earnable by watching and not yet earned.
 */
function earnableMinutes(
  campaign: Campaign | undefined,
  inventory: InventorySnapshot | null,
  now: number,
): number | null {
  if (campaign === undefined || inventory === null || !inventory.available) return null;
  const drops = resolveCampaign(campaign, inventory).drops;
  const open = drops.some((d) =>
    (d.status === "in-progress" || d.status === "not-started")
    && (d.startsAt == null || d.startsAt <= now)
    && (d.endsAt == null || d.endsAt > now));
  if (!open) return null;
  return drops.reduce((sum, d) => sum + d.minutes, 0);
}
