import type {
  Campaign, CampaignBenefit, CampaignDrop,
} from "./campaignCatalogue.js";
import type { DropProgressEntry, InventorySnapshot } from "./inventory.js";

/**
 * What a single drop is doing for this viewer.
 *
 * `unknown` is not a failure mode to be tidied away. It is the honest
 * answer when the inventory could not be read, and it is what stops the
 * page rendering a wall of zeroes that look like facts.
 */
export type DropStatus =
  | "unobtainable"
  | "claimed"
  | "claimable"
  | "in-progress"
  | "not-started"
  | "unknown";

export type CampaignStatus = "collected" | "partial" | "untouched" | "unknown";

export interface ResolvedDrop {
  id: string;
  name: string;
  benefits: CampaignBenefit[];
  requiredMinutes: number;
  /** Clamped to requiredMinutes; 0 when not started or unknown. */
  minutes: number;
  status: DropStatus;
  /**
   * The drop's own window, null when the source did not report one.
   *
   * Normalised from the optional field on CampaignDrop so the API shape
   * is stable: a catalogue loaded from disk before these were parsed
   * reports null here rather than omitting the key.
   */
  startsAt: number | null;
  endsAt: number | null;
}

export interface ResolvedCampaign extends Omit<Campaign, "drops"> {
  drops: ResolvedDrop[];
  status: CampaignStatus;
  /** Whether watching has nothing left to add; see campaignComplete. */
  complete: boolean;
}

/**
 * One drop's state, from its definition plus whatever the inventory knows.
 *
 * The order of the checks is the specification. `unobtainable` is tested
 * first because a drop watching cannot earn stays that way however much
 * progress exists against it, and `unknown` is tested before
 * `not-started` because an absent entry means two different things
 * depending on whether the fetch worked.
 *
 * Three signals make a drop unobtainable, because no one of them is
 * enough on its own:
 *
 *   - `requiredSubs > 0`, Twitch's own field. Authoritative when set,
 *     but the public tracker the catalogue comes from never populates
 *     it -- `requiresSub` is false on every drop in the live feed,
 *     including campaigns literally named "Sub Drops" -- so in practice
 *     this catches nothing. Kept because the field is right when a
 *     source does fill it.
 *   - `requiredMinutes <= 0`. What actually catches these today. A drop
 *     earnable by watching must cost some watching, so zero required
 *     minutes means the gate is something else: a sub, a gift sub, an
 *     external hunt. Available for every drop, including ones with no
 *     inventory entry, which is why it carries the catalogue-only case.
 *   - `preconditionsMet === false`, from the Inventory self edge. The
 *     authoritative signal, and the only one that knows about a drop
 *     gated behind something the catalogue does not describe -- but it
 *     exists only for campaigns in `dropCampaignsInProgress`, so it
 *     supplements the rule above rather than replacing it.
 *
 * A claimed or claimable drop is never unobtainable whatever the
 * preconditions say: the reward is already earned or already minted, so
 * the gate was passed. Only the first two signals, which describe the
 * drop itself rather than this viewer's progress, override that.
 *
 * `earned` is the rescue for an absent entry. Progress comes from
 * `dropCampaignsInProgress`, which a campaign leaves once every drop is
 * claimed, so absence alone cannot tell a finished campaign from an
 * untouched one -- and read as "not started" it badged a completed
 * campaign as never begun. It is consulted only where there is no entry:
 * a live entry carries minutes and an instance id, which is the more
 * specific fact, and matching by name must not overwrite it.
 */
export function resolveDrop(
  drop: CampaignDrop,
  entry: DropProgressEntry | undefined,
  available: boolean,
  /** Reward names claimed from this drop's campaign. */
  earned: readonly string[] = [],
): ResolvedDrop {
  const base = {
    id: drop.id,
    name: drop.name,
    benefits: drop.benefits ?? [],
    requiredMinutes: drop.requiredMinutes,
    startsAt: drop.startsAt ?? null,
    endsAt: drop.endsAt ?? null,
  };

  // Properties of the drop itself, true before any viewer looks at it,
  // so they outrank even a claimed reward matched by name.
  if (drop.requiredSubs > 0 || drop.requiredMinutes <= 0) {
    return { ...base, minutes: 0, status: "unobtainable" };
  }

  if (entry === undefined) {
    // A reward of this drop's already in hand: the campaign finished and
    // dropped out of the progress map. Only when the fetch worked -- a
    // failure reports no rewards either, and trusting that empty list
    // would badge every finished campaign untouched.
    //
    // Minutes report the full requirement rather than zero: the reward
    // is proof the requirement was met, and a drawn-empty bar under a
    // finished drop reads as lost progress. A drop with no benefits
    // matches nothing, rather than matching everything.
    if (available && drop.benefits !== undefined
        && drop.benefits.some((b) => earned.includes(b.name))) {
      return { ...base, minutes: drop.requiredMinutes, status: "claimed" };
    }
    return {
      ...base,
      minutes: 0,
      status: available ? "not-started" : "unknown",
    };
  }

  // Clamped: Twitch keeps counting past the requirement, and a bar
  // reporting 71/60 reads as a bug rather than a finished drop.
  const minutes = Math.min(entry.minutes, drop.requiredMinutes);
  if (entry.claimed) return { ...base, minutes, status: "claimed" };
  if (entry.instanceId !== null) {
    return { ...base, minutes, status: "claimable" };
  }
  // Twitch says the gate is shut, and nothing above proved otherwise.
  // Strictly false: null and undefined mean the source did not say, and
  // reading silence as "blocked" would mark every ordinary drop
  // unobtainable the moment a helper stopped reporting the field.
  if (entry.preconditionsMet === false) {
    return { ...base, minutes, status: "unobtainable" };
  }
  return {
    ...base,
    minutes,
    status: minutes > 0 ? "in-progress" : "not-started",
  };
}

/**
 * A campaign's drops resolved, plus the one-word verdict the list shows.
 *
 * Pure: the caller supplies both halves, so this can be tested
 * exhaustively without a clock or a network.
 */
export function resolveCampaign(
  campaign: Campaign,
  inv: InventorySnapshot,
): ResolvedCampaign {
  // Keyed by campaign id, so progress earned in a different campaign is
  // never attributed to this one. The claimed rewards are keyed the same
  // way and for the same reason -- reward names repeat across campaigns.
  const entries = inv.progress[campaign.id] ?? {};
  const earned = inv.earned[campaign.id] ?? [];
  const drops = campaign.drops.map((d) =>
    resolveDrop(d, entries[d.id], inv.available, earned),
  );
  return {
    ...campaign,
    drops,
    status: campaignStatus(drops, inv.available),
    complete: campaignComplete(drops, inv.available),
  };
}

/**
 * Whether watching has nothing left to add to a campaign.
 *
 * Wider than "collected": claimable counts as done, because the minutes
 * are in and the miner claims from the inventory whichever channels it
 * is watching. Unobtainable drops are ignored as in campaignStatus, and
 * a campaign of nothing else is not complete -- nothing was earned.
 * Unread progress never completes anything.
 */
function campaignComplete(drops: ResolvedDrop[], available: boolean): boolean {
  if (!available) return false;
  const obtainable = drops.filter((d) => d.status !== "unobtainable");
  return obtainable.length > 0
    && obtainable.every((d) => d.status === "claimed" || d.status === "claimable");
}

/**
 * The campaign-level verdict, which is what the list is scanned for.
 *
 * Unobtainable drops are excluded throughout: they can never be
 * collected by watching, so counting them would leave such a campaign
 * permanently "partial" no matter what the viewer does -- the bug that
 * left a fully-watched campaign showing an unclaimed gift-sub drop --
 * but a campaign of nothing else must not report "collected" either,
 * since nothing was.
 */
function campaignStatus(
  drops: ResolvedDrop[],
  available: boolean,
): CampaignStatus {
  if (!available) return "unknown";
  const obtainable = drops.filter((d) => d.status !== "unobtainable");
  if (obtainable.length === 0) return "untouched";
  if (obtainable.every((d) => d.status === "claimed")) return "collected";
  return obtainable.some((d) => d.status !== "not-started")
    ? "partial"
    : "untouched";
}
