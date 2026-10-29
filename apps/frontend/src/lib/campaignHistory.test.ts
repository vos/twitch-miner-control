import { expect, test } from "vitest";
import { watchedCampaigns } from "./campaignHistory.js";
import type { ResolvedCampaign } from "../components/CampaignCard.js";

const c = (id: string, over: Partial<ResolvedCampaign> = {}): ResolvedCampaign => ({
  id, name: id, game: null, startsAt: 1, endsAt: 5_000, drops: [],
  status: "partial", complete: false, ...over,
});

test("lists recorded campaigns beside the live ones with progress", () => {
  const out = watchedCampaigns(
    [c("live", { endsAt: 9_000 }), c("untouched", { status: "untouched" })],
    [c("gone", { endsAt: 3_000 })],
  );
  expect(out.map((x) => x.id)).toEqual(["live", "gone"]);
});

test("shows a campaign still running as it is now, not as recorded", () => {
  const out = watchedCampaigns(
    [c("c1", { status: "collected" })],
    [c("c1", { status: "partial" })],
  );
  expect(out).toEqual([c("c1", { status: "collected" })]);
});

test("keeps the record while live progress cannot be read", () => {
  // "unknown" is an outage, not a campaign that was never watched.
  const out = watchedCampaigns([c("c1", { status: "unknown" })], [c("c1")]);
  expect(out).toEqual([c("c1")]);
});

test("puts the most recently ended first and an unknown end last", () => {
  const out = watchedCampaigns([], [
    c("open", { endsAt: null }), c("old", { endsAt: 1_000 }), c("new", { endsAt: 4_000 }),
  ]);
  expect(out.map((x) => x.id)).toEqual(["new", "old", "open"]);
});
