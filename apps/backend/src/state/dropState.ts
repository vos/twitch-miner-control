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
}

/**
 * One drop's state, from its definition plus whatever the inventory knows.
 *
 * The order of the checks is the specification. `unobtainable` is tested
 * first because a sub-gated drop can never be earned by watching however
 * much progress exists against it, and `unknown` is tested before
 * `not-started` because an absent entry means two different things
 * depending on whether the fetch worked.
 */
export function resolveDrop(
  drop: CampaignDrop,
  entry: DropProgressEntry | undefined,
  available: boolean,
): ResolvedDrop {
  const base = {
    id: drop.id,
    name: drop.name,
    benefits: drop.benefits ?? [],
    requiredMinutes: drop.requiredMinutes,
    startsAt: drop.startsAt ?? null,
    endsAt: drop.endsAt ?? null,
  };

  if (drop.requiredSubs > 0) {
    return { ...base, minutes: 0, status: "unobtainable" };
  }

  if (entry === undefined) {
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
  // never attributed to this one.
  const entries = inv.progress[campaign.id] ?? {};
  const drops = campaign.drops.map((d) =>
    resolveDrop(d, entries[d.id], inv.available),
  );
  return { ...campaign, drops, status: campaignStatus(drops, inv.available) };
}

/**
 * The campaign-level verdict, which is what the list is scanned for.
 *
 * Sub-gated drops are excluded throughout: they can never be collected,
 * so counting them would leave such a campaign permanently "partial" no
 * matter what the viewer does -- but a campaign of nothing else must not
 * report "collected" either, since nothing was.
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
