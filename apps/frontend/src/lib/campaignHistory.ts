import type { ResolvedCampaign } from "../components/CampaignCard.js";

const watched = (c: ResolvedCampaign) => c.status === "partial" || c.status === "collected";

/**
 * Every campaign this account made progress on, for the History view.
 *
 * The recorded ones, with each still running shown as it is now rather
 * than as last recorded -- unless its progress cannot be read right now:
 * an outage resolves it "unknown", which is not "never watched", so the
 * record stands in. Most recently ended first; an unknown end last, as
 * it says nothing about recency.
 */
export function watchedCampaigns(
  live: readonly ResolvedCampaign[],
  recorded: readonly ResolvedCampaign[],
): ResolvedCampaign[] {
  const byId = new Map(recorded.map((c) => [c.id, c]));
  for (const c of live) if (watched(c)) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) =>
    (b.endsAt ?? -Infinity) - (a.endsAt ?? -Infinity) || a.name.localeCompare(b.name));
}
