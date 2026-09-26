import { expect, test, vi } from "vitest";
import type { Campaign, Catalogue } from "../../state/campaignCatalogue.js";
import type { InventorySnapshot } from "../../state/inventory.js";
import type { PublishInput } from "../catalogue.js";
import {
  CampaignWatcher, ENDING_SOON_MS, campaignFollowedNotification, campaignStartedNotification,
} from "./campaigns.js";

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

const campaign = (id: string, over: Partial<Campaign> = {}): Campaign => ({
  id, name: `Campaign ${id}`, game: { id: "g1", slug: "rust", displayName: "Rust" },
  startsAt: null, endsAt: NOW + 10 * 24 * HOUR,
  drops: ["d1", "d2"].map((d) => ({
    id: `${id}-${d}`, name: d, benefits: [], requiredMinutes: 60, requiredSubs: 0,
  })) as never,
  ...over,
});

const claimed = { minutes: 60, claimed: true, instanceId: null };
const halfway = { minutes: 30, claimed: false, instanceId: null };

function harness() {
  const seen = new Set<string>();
  const markSeen = (key: string) => (seen.has(key) ? false : (seen.add(key), true));
  const published: PublishInput[] = [];
  const publish = vi.fn((n: PublishInput) => {
    if (n.dedupeKey !== undefined && !markSeen(n.dedupeKey)) return;
    published.push(n);
  });
  let campaigns: Campaign[] = [];
  let progress: InventorySnapshot["progress"] = {};
  const catalogueGet = vi.fn(async (): Promise<Catalogue> => ({
    campaigns, fetchedAt: 1, stale: false, available: true, error: null,
  }));
  const watcher = new CampaignWatcher({
    notifier: { publish, markSeen },
    catalogue: { get: catalogueGet },
    inventory: { get: async () => ({ progress, earned: {}, fetchedAt: 1, available: true }) },
    now: () => NOW,
  });
  return {
    watcher, published, catalogueGet,
    set: (c: Campaign[], p: InventorySnapshot["progress"]) => { campaigns = c; progress = p; },
  };
}

test("completions publish once the watcher is primed", async () => {
  const h = harness();
  h.set([campaign("c1")], { c1: { "c1-d1": claimed, "c1-d2": claimed } });
  await h.watcher.pass(); // primes: the first run ever stays quiet
  h.set([campaign("c1"), campaign("c2")], {
    c1: { "c1-d1": claimed, "c1-d2": claimed },
    c2: { "c2-d1": claimed, "c2-d2": claimed },
  });
  await h.watcher.pass();
  expect(h.catalogueGet).toHaveBeenCalled();
  expect(h.published.map((n) => [n.kind, n.link])).toEqual([
    ["campaign.completed", "/?open=drops&campaign=c2"],
  ]);
});

test("the first run ever stays quiet about completions it finds, later ones are published once", async () => {
  const h = harness();
  h.set([campaign("c1")], { c1: { "c1-d1": claimed, "c1-d2": claimed } });
  await h.watcher.pass();
  expect(h.published).toEqual([]);
  h.set([campaign("c1"), campaign("c2")], {
    c1: { "c1-d1": claimed, "c1-d2": claimed },
    c2: { "c2-d1": claimed, "c2-d2": claimed },
  });
  await h.watcher.pass();
  await h.watcher.pass();
  expect(h.published.map((n) => [n.kind, n.link])).toEqual([
    ["campaign.completed", "/?open=drops&campaign=c2"],
  ]);
});

test("a campaign ending soon with progress is published once", async () => {
  const h = harness();
  h.set([
    campaign("soon", { endsAt: NOW + 3 * HOUR }),
    campaign("later", { endsAt: NOW + ENDING_SOON_MS + HOUR }),
    campaign("untouched", { endsAt: NOW + 3 * HOUR }),
  ], {
    soon: { "soon-d1": halfway },
    later: { "later-d1": halfway },
  });
  await h.watcher.pass();
  await h.watcher.pass();
  expect(h.published.map((n) => [n.kind, n.body])).toEqual([
    ["campaign.endingSoon", "\"Campaign soon\" ends in 3 h with drops still unclaimed."],
  ]);
});


test("a campaign start reads as what happened", () => {
  expect(campaignStartedNotification({ subscriptionId: "s1", label: "Rust Drops", targetId: "c1", why: "queue" }))
    .toEqual({
      kind: "campaign.started", title: "Campaign started",
      body: "\"Rust Drops\" is next in the queue and is now being collected.",
      link: "/?open=drops&campaign=c1",
    });
});

test("a campaign a followed game subscribed to reads as what happened", () => {
  expect(campaignFollowedNotification({
    subscriptionId: "s1", label: "Nightreign Drops", targetId: "c9", game: "ELDEN RING",
  })).toEqual({
    kind: "campaign.new", title: "New campaign",
    body: "\"Nightreign Drops\" for ELDEN RING was subscribed automatically.",
    link: "/?open=drops&campaign=c9", dedupeKey: "campaign.new:c9",
  });
});
