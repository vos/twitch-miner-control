import type { ResolvedCampaign } from "../components/CampaignCard.js";

// Every function here takes the needle already trimmed and lowercased.

/** Whether a campaign's own name or its game contains the needle. */
export function matchesHeader(c: ResolvedCampaign, needle: string): boolean {
  return c.name.toLowerCase().includes(needle)
    || (c.game?.displayName.toLowerCase().includes(needle) ?? false);
}

/** Whether any drop inside the campaign contains the needle. */
export function matchesDrop(c: ResolvedCampaign, needle: string): boolean {
  return c.drops.some((d) => d.name.toLowerCase().includes(needle));
}

/**
 * Name, game or drop. The game is how most campaigns are found, and the
 * drop is often the only name a player knows: they are hunting a
 * particular skin, not whatever the campaign offering it is called.
 */
export function matchesCampaign(c: ResolvedCampaign, needle: string): boolean {
  return matchesHeader(c, needle) || matchesDrop(c, needle);
}
