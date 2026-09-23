import { expect, test } from "vitest";
import type { ResolvedCampaign } from "../components/CampaignCard.js";
import { matchesCampaign, matchesDrop, matchesHeader } from "./campaignMatch.js";

const campaign = {
  id: "c1", name: "Winter Event",
  game: { id: "g1", slug: "rust", displayName: "Rust" },
  startsAt: null, endsAt: null, status: "untouched", complete: false,
  drops: [{ id: "d1", name: "Gilded Helmet", benefits: [], requiredMinutes: 60,
            minutes: 0, status: "not-started" }],
} as unknown as ResolvedCampaign;

test("the header covers the campaign's name and its game", () => {
  expect(matchesHeader(campaign, "winter")).toBe(true);
  expect(matchesHeader(campaign, "rust")).toBe(true);
  expect(matchesHeader(campaign, "helmet")).toBe(false);
});

test("a drop matches by its own name", () => {
  expect(matchesDrop(campaign, "helmet")).toBe(true);
  expect(matchesDrop(campaign, "winter")).toBe(false);
});

test("a campaign matches by any of the three", () => {
  expect(matchesCampaign(campaign, "winter")).toBe(true);
  expect(matchesCampaign(campaign, "rust")).toBe(true);
  expect(matchesCampaign(campaign, "helmet")).toBe(true);
  expect(matchesCampaign(campaign, "apex")).toBe(false);
});
