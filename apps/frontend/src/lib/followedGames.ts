import type { ResolvedCampaign } from "../components/CampaignCard.js";
import { formatSpan } from "./formatSpan.js";

/** A Twitch category, as the search and the follow route report it. */
export interface TwitchGame {
  id: string;
  name: string;
  slug: string;
  boxArtUrl: string | null;
  /** From the search only: when its last drop campaign ended. */
  lastEndedAt?: number | null;
}

/** How a game runs drops, from the tracker's history. */
export interface DropRhythm {
  /** When its most recent finished campaign ended; null if none known. */
  lastEndedAt: number | null;
  /** Its usual days between campaigns; null when it has no rhythm. */
  everyDays: number | null;
}

/** A followed game, as GET /api/subscriptions reports it. */
export interface FollowedGame extends TwitchGame {
  poolSize: number;
  skipped: string[];
  /** Absent from a backend that predates it. */
  rhythm?: DropRhythm;
}

export interface FollowResponse {
  added: TwitchGame[];
  alreadyFollowed: string[];
  notFound: string[];
}

/** How many of a game's campaigns are listed and not over. */
export function runningCampaigns(
  gameId: string,
  campaigns: readonly ResolvedCampaign[],
  now = Date.now(),
): number {
  return campaigns.filter(
    (c) => c.game?.id === gameId && (c.endsAt === null || c.endsAt > now),
  ).length;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * One line saying what a follow did, for the Followed games card.
 *
 * `subscribed` is what the follow added; `running` is how many campaigns
 * the followed games have. They differ when campaigns run but give the
 * follow nothing to add -- already collected, not earned by watching, or
 * subscribed by hand -- which is not the same as none running.
 */
export function followSummary(
  res: FollowResponse,
  subscribed: number,
  running: number,
): string {
  const parts: string[] = [];
  const [first] = res.added;
  if (first !== undefined) {
    parts.push(res.added.length === 1
      ? `Following ${first.name}`
      : `Following ${res.added.length} games`);
    parts.push(subscribed > 0
      ? `${subscribed} ${plural(subscribed, "campaign", "campaigns")} subscribed`
      : running > 0
        ? `${running} ${plural(running, "campaign", "campaigns")} running, none left to subscribe to`
        : "no campaigns running right now");
  } else if (res.alreadyFollowed.length > 0) {
    parts.push("Already following");
  }
  if (res.notFound.length > 0) parts.push(`${res.notFound.length} not found on Twitch`);
  return parts.join(" · ");
}

/**
 * The name of the game that added a subscription, for its Auto badge.
 *
 * The followed game first; the catalogue when it has since been
 * unfollowed; null when neither knows it.
 */
export function viaGameName(
  viaGame: string,
  followed: readonly FollowedGame[],
  campaigns: readonly ResolvedCampaign[],
): string | null {
  return followed.find((g) => g.id === viaGame)?.name
    ?? campaigns.find((c) => c.game?.id === viaGame)?.game?.displayName
    ?? null;
}

/** A campaign a followed game skipped, as the Subscriptions card lists it. */
export interface SkippedCampaign {
  game: FollowedGame;
  campaign: ResolvedCampaign;
}

/**
 * The skipped campaigns worth offering to unskip.
 *
 * `skipped` also holds campaigns that ended or completed, which would only
 * be skipped again; and one subscribed by hand is already being collected.
 * A campaign gone from the catalogue has nothing left to show.
 */
export function skippedCampaigns(
  followed: readonly FollowedGame[],
  campaigns: readonly ResolvedCampaign[],
  subscriptions: readonly { targetId: string }[],
  now = Date.now(),
): SkippedCampaign[] {
  const subscribed = new Set(subscriptions.map((s) => s.targetId));
  return followed.flatMap((game) => game.skipped.flatMap((id) => {
    const campaign = campaigns.find((c) => c.id === id);
    if (campaign === undefined || campaign.complete || subscribed.has(id)) return [];
    if (campaign.endsAt !== null && campaign.endsAt <= now) return [];
    return [{ game, campaign }];
  }));
}

/**
 * How often, in the unit that reads best.
 *
 * Words rather than formatSpan's "14d": this is a habit, not a readout,
 * and "every ~14d" reads as a timer.
 */
export function rhythmLabel(everyDays: number): string {
  if (everyDays <= 1) return "almost daily";
  if (everyDays < 7) return `usually every ~${everyDays} days`;
  if (everyDays < 50) {
    const weeks = Math.round(everyDays / 7);
    return weeks === 1 ? "usually weekly" : `usually every ~${weeks} weeks`;
  }
  return `usually every ~${Math.round(everyDays / 30)} months`;
}

/**
 * When a followed game between campaigns last ran, and how often.
 *
 * Null when the tracker knows neither -- no line beats "last ran never".
 */
export function idleActivity(rhythm: DropRhythm | undefined, now = Date.now()): string | null {
  const parts: string[] = [];
  if (rhythm?.lastEndedAt != null) {
    parts.push(`last ran ${formatSpan(now - rhythm.lastEndedAt)} ago`);
  }
  if (rhythm?.everyDays != null) parts.push(rhythmLabel(rhythm.everyDays));
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A search result's last campaign, or null when the tracker never saw one. */
export function dropsLastRan(
  lastEndedAt: number | null | undefined,
  now = Date.now(),
): string | null {
  return lastEndedAt == null ? null : `drops last ran ${formatSpan(now - lastEndedAt)} ago`;
}
