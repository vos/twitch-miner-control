import type { Subscription } from "../config/schema.js";
import type { Campaign } from "../state/campaignCatalogue.js";

/** One live channel the directory reported for a game. */
export interface DirectoryChannel {
  login: string;
  channelId: string;
  viewers: number;
}

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
}

/**
 * Which game a subscription watches for, or null when unanswerable.
 *
 * A campaign subscription takes its game from the campaign, so it stops
 * resolving once the campaign leaves the catalogue. A game subscription
 * carries its own target and is not tied to any campaign's lifetime,
 * which is the point of having the kind at all.
 */
function target(
  sub: Subscription,
  campaign: Campaign | undefined,
): { id: string; name: string; slug: string } | null {
  if (sub.kind === "game") {
    return { id: sub.targetId, name: sub.label, slug: "" };
  }
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
  if (target(sub, campaign) === null) return { channels: [], degraded: true };
  if (directory === null) return { channels: [], degraded: true };

  // A pool with any live member is returned WHOLE, offline members
  // included. Dropping the offline ones would rewrite the config and
  // restart the miner for no gain, and they are exactly the channels the
  // miner should pick up again when they come back -- which it can do on
  // its own, without a restart, because they are already in its list.
  const live = new Set(directory.map((c) => c.login.toLowerCase()));
  const anyLive = incumbents.some((login) => live.has(login.toLowerCase()));
  // The config's own spelling is kept, so a directory that reports a
  // different casing than the config holds does not rewrite the entry.
  if (anyLive) return { channels: [...incumbents], degraded: false };

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
  };
}

/** The game to ask the directory about, for a subscription. */
export function directoryTarget(
  sub: Subscription,
  campaign: Campaign | undefined,
): { name: string; slug: string } | null {
  const game = target(sub, campaign);
  return game === null ? null : { name: game.name, slug: game.slug };
}
