import type { Subscription } from "../config/schema.js";
import type { Campaign } from "../state/campaignCatalogue.js";

/** One live channel the directory reported for a game. */
export interface DirectoryChannel {
  login: string;
  channelId: string;
  viewers: number;
}

/**
 * Why a resolution came out the way it did.
 *
 * Returned rather than logged from inside, so the function stays pure and
 * a test can assert the DECISION itself rather than a side effect. The
 * engine turns this into an event.
 */
export type ResolutionDecision =
  /** At least one incumbent was live, so the pool was left alone. */
  | "kept"
  /** Nobody was live, so the pool was rebuilt from the directory. */
  | "rebuilt"
  /** No game to ask about: an unknown campaign, or one with no game. */
  | "no-target"
  /** The directory could not be reached. */
  | "directory-failed";

export interface ResolutionResult {
  channels: string[];
  /**
   * True when we could not resolve properly, and the caller should keep
   * whatever pool it already has rather than adopting `channels`.
   *
   * Distinct from resolving to an empty list, which is a real answer:
   * the directory replied and nobody is streaming the game. Degraded
   * means we never got to ask.
   */
  degraded: boolean;
  /** Why this result is what it is, for the caller to report. */
  decision: ResolutionDecision;
  /**
   * How many incumbents the directory still reported as live.
   *
   * The evidence behind a "kept": one live member out of three is the
   * case the pool exists for, and is worth being able to see after the
   * fact. Zero on a rebuild, and undefined when degraded -- we never
   * found out.
   */
  liveCount?: number;
}

/**
 * Which game a subscription's campaign is for, or null when unanswerable.
 *
 * Taken from the campaign, so a subscription stops resolving once its
 * campaign leaves the catalogue.
 */
function target(
  campaign: Campaign | undefined,
): { id: string; name: string; slug: string } | null {
  if (campaign?.game == null) return null;
  return {
    id: campaign.game.id,
    name: campaign.game.displayName,
    slug: campaign.game.slug,
  };
}

/**
 * The channels a subscription wants watched, best first.
 *
 * One path only. Twitch's campaign API carries a channel allowlist that
 * would have let allowlisted campaigns resolve without the directory at
 * all, but the public tracker the catalogue reads does not expose one --
 * so every subscription goes through the directory, and the directory is
 * the single point of failure. See campaignSource.ts for why the
 * catalogue is not Twitch's own.
 *
 * A pool that still has ONE live member is left exactly as it is. That
 * member is collecting the drop, and every alternative -- reordering by
 * viewers, evicting a live member for a bigger channel, topping the pool
 * back up to full -- costs a miner restart and the watch-session state
 * that goes with it, to buy nothing the drop needs right now. A pool is
 * rebuilt only once nobody in it is live, because only then has
 * collection actually stopped. The cost is a little downtime when that
 * last member goes offline mid-interval, which is the trade the pool
 * exists to make.
 *
 * `degraded` never means "use an empty pool". Emptying a pool stops drop
 * collection with no visible cause, which is the one failure the user
 * cannot see.
 */
export function resolveSubscription(
  sub: Subscription,
  campaign: Campaign | undefined,
  directory: DirectoryChannel[] | null,
  incumbents: readonly string[] = [],
): ResolutionResult {
  if (target(campaign) === null) {
    return { channels: [], degraded: true, decision: "no-target" };
  }
  if (directory === null) {
    return { channels: [], degraded: true, decision: "directory-failed" };
  }

  // A pool with any live member is returned WHOLE, offline members
  // included. Dropping the offline ones would rewrite the config and
  // restart the miner for no gain, and they are exactly the channels the
  // miner should pick up again when they come back -- which it can do on
  // its own, without a restart, because they are already in its list.
  const live = new Set(directory.map((c) => c.login.toLowerCase()));
  const liveCount = incumbents.filter((l) => live.has(l.toLowerCase())).length;
  // The config's own spelling is kept, so a directory that reports a
  // different casing than the config holds does not rewrite the entry.
  if (liveCount > 0) {
    return {
      channels: [...incumbents], degraded: false, decision: "kept", liveCount,
    };
  }

  // Nobody left. Viewers descending: a bigger channel is likelier to
  // still be live at the end of a drop, which is what the pool exists to
  // protect against. Ties break by login so two rebuilds from the same
  // directory agree, rather than restarting over an arbitrary shuffle.
  return {
    channels: [...directory]
      .sort((a, b) => b.viewers - a.viewers || a.login.localeCompare(b.login))
      .slice(0, sub.poolSize)
      .map((c) => c.login),
    degraded: false,
    decision: "rebuilt",
    liveCount: 0,
  };
}

/** The game to ask the directory about, for a subscription's campaign. */
export function directoryTarget(
  campaign: Campaign | undefined,
): { name: string; slug: string } | null {
  const game = target(campaign);
  return game === null ? null : { name: game.name, slug: game.slug };
}
