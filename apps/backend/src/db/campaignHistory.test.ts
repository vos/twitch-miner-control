import { beforeEach, expect, test } from "vitest";
import { CampaignHistory } from "./campaignHistory.js";
import { openDb } from "./schema.js";
import type { ResolvedCampaign } from "../state/dropState.js";

let store: CampaignHistory;
beforeEach(() => { store = new CampaignHistory(openDb(":memory:")); });

const campaign = (over: Partial<ResolvedCampaign> = {}): ResolvedCampaign => ({
  id: "c1",
  name: "Halloween",
  game: { id: "g1", slug: "a-game", displayName: "A Game", boxArtUrl: null },
  owner: null,
  startsAt: 1_000,
  endsAt: 9_000,
  drops: [],
  status: "partial",
  complete: false,
  accountLink: null,
  ...over,
});

test("keeps a recorded campaign as it last looked", () => {
  store.record(campaign(), 100);
  store.record(campaign({ status: "collected", complete: true }), 200);
  expect(store.all()).toEqual([campaign({ status: "collected", complete: true })]);
});

test("lists the most recently ended first", () => {
  store.record(campaign({ id: "old", endsAt: 5_000 }), 100);
  store.record(campaign({ id: "new", endsAt: 8_000 }), 100);
  store.record(campaign({ id: "open", endsAt: null }), 100);
  expect(store.all().map((c) => c.id)).toEqual(["new", "old", "open"]);
});

test("rewrites a campaign only when it changed", () => {
  // Recorded every fifteen minutes for weeks; an unchanged snapshot must
  // not cost a write each time.
  expect(store.record(campaign(), 100)).toBe(true);
  expect(store.record(campaign(), 200)).toBe(false);
  expect(store.record(campaign({ status: "collected" }), 300)).toBe(true);
});

test("survives a reopen of the same database", () => {
  const db = openDb(":memory:");
  new CampaignHistory(db).record(campaign(), 100);
  expect(new CampaignHistory(db).all()).toHaveLength(1);
});
