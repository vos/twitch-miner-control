import type { AppConfig, FollowedGame, Subscription } from "../config/schema.js";
import type { Campaign, Catalogue } from "../state/campaignCatalogue.js";
import { resolveCampaign } from "../state/dropState.js";
import type { InventorySnapshot } from "../state/inventory.js";

/** A campaign subscription a followed game has just added. */
export interface FollowedAddition {
  subscription: Subscription;
  game: FollowedGame;
  campaign: Campaign;
}

export interface FollowResult {
  added: FollowedAddition[];
  /** The followed games with `skipped` pruned; the same objects when unchanged. */
  followedGames: FollowedGame[];
  /** Whether anything here differs from the config passed in. */
  changed: boolean;
}

/**
 * Progress we could not read. Completion is unknown then, so nothing is
 * held back as complete -- the engine removes it once progress says so.
 */
const UNREAD: InventorySnapshot = { progress: {}, earned: {}, fetchedAt: 0, available: false };

/**
 * Which catalogue campaigns the followed games subscribe to now.
 *
 * Pure: the engine applies the result in its own single write. A
 * campaign is added when its game is followed and it is not already
 * subscribed, not skipped, not over, not already complete, and has at
 * least one drop watching can earn. One already complete is skipped
 * outright, so a later pass that cannot read progress does not add it.
 *
 * Nothing is added from an unavailable catalogue. A stale one still
 * adds: its end dates are still true, and they filter out what is over.
 * Only a fresh one prunes `skipped`, since only it can say a campaign is
 * gone.
 */
export function followGames(
  config: Pick<AppConfig, "subscriptions" | "followedGames">,
  catalogue: Pick<Catalogue, "campaigns" | "available" | "stale">,
  inventory: InventorySnapshot | null,
  now: number,
  newId: () => string,
): FollowResult {
  if (config.followedGames.length === 0 || !catalogue.available) {
    return { added: [], followedGames: config.followedGames, changed: false };
  }
  const listed = new Set(catalogue.campaigns.map((c) => c.id));
  const subscribed = new Set(config.subscriptions.map((s) => s.targetId));
  // After the highest rank rather than the count: removals leave gaps,
  // and a count can land on a rank already taken.
  let rank = config.subscriptions.reduce((max, s) => Math.max(max, s.rank), -1);
  const added: FollowedAddition[] = [];
  let edited = false;

  const followedGames = config.followedGames.map((game) => {
    let skipped = game.skipped;
    if (!catalogue.stale) {
      const kept = game.skipped.filter((id) => listed.has(id));
      if (kept.length !== game.skipped.length) {
        skipped = kept;
        edited = true;
      }
    }
    for (const campaign of catalogue.campaigns) {
      if (campaign.game?.id !== game.id) continue;
      if (subscribed.has(campaign.id) || skipped.includes(campaign.id)) continue;
      if (campaign.endsAt !== null && campaign.endsAt <= now) continue;
      const resolved = resolveCampaign(campaign, inventory ?? UNREAD);
      if (resolved.complete) {
        skipped = [...skipped, campaign.id];
        edited = true;
        continue;
      }
      if (!resolved.drops.some((d) => d.status !== "unobtainable")) continue;
      subscribed.add(campaign.id);
      added.push({
        game,
        campaign,
        subscription: {
          id: newId(),
          targetId: campaign.id,
          label: campaign.name,
          poolSize: game.poolSize,
          rank: ++rank,
          viaGame: game.id,
        },
      });
    }
    return skipped === game.skipped ? game : { ...game, skipped };
  });

  return { added, followedGames, changed: edited || added.length > 0 };
}

/**
 * The followed games with each leaving subscription's campaign skipped.
 *
 * Filed under the game that added it, or -- for one added by hand --
 * under the followed game its campaign belongs to, when
 * `gameOfCampaign` can say. Either way the game will not add it back.
 */
export function recordSkipped(
  games: FollowedGame[],
  leaving: readonly Subscription[],
  gameOfCampaign: (campaignId: string) => string | undefined = () => undefined,
): FollowedGame[] {
  return games.map((game) => {
    const ids = leaving
      .filter((s) => (s.viaGame ?? gameOfCampaign(s.targetId)) === game.id)
      .map((s) => s.targetId)
      .filter((id) => !game.skipped.includes(id));
    return ids.length === 0 ? game : { ...game, skipped: [...game.skipped, ...ids] };
  });
}
