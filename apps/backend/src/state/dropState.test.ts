import { expect, test } from "vitest";
import { resolveCampaign, resolveDrop } from "./dropState.js";
import type { Campaign, CampaignDrop } from "./campaignCatalogue.js";
import type { InventoryMap, InventorySnapshot } from "./inventory.js";

const drop = (over: Partial<CampaignDrop> = {}): CampaignDrop => ({
  id: "d1",
  name: "Crate",
  benefits: ["Crate"],
  requiredMinutes: 60,
  requiredSubs: 0,
  ...over,
});

const campaign = (drops: CampaignDrop[]): Campaign => ({
  id: "c1",
  name: "Campaign One",
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1_000,
  endsAt: 9_000,
  allowChannelIds: [],
  drops,
});

const snapshot = (
  progress: InventoryMap,
  available = true,
): InventorySnapshot => ({ progress, fetchedAt: 1_000, available });

// --- drop states ---

test("a sub-gated drop is unobtainable", () => {
  // Drop.update sets is_claimable False whenever subs_required > 0, so
  // watching can never finish it. Reporting it as merely "not started"
  // means "collect all drops" silently never completes.
  expect(resolveDrop(drop({ requiredSubs: 1 }), undefined, true).status).toBe(
    "unobtainable",
  );
});

test("unobtainable wins even over recorded progress", () => {
  const out = resolveDrop(
    drop({ requiredSubs: 1 }),
    { minutes: 30, claimed: false, instanceId: null },
    true,
  );
  expect(out.status).toBe("unobtainable");
});

test("a claimed drop reports claimed", () => {
  const out = resolveDrop(
    drop(),
    { minutes: 60, claimed: true, instanceId: "i1" },
    true,
  );
  expect(out.status).toBe("claimed");
});

test("an instance minted but unclaimed is claimable", () => {
  const out = resolveDrop(
    drop(),
    { minutes: 60, claimed: false, instanceId: "i1" },
    true,
  );
  expect(out.status).toBe("claimable");
});

test("partial minutes report in-progress", () => {
  const out = resolveDrop(
    drop(),
    { minutes: 30, claimed: false, instanceId: null },
    true,
  );
  expect(out.status).toBe("in-progress");
  expect(out.minutes).toBe(30);
});

test("absent from an available inventory means not started", () => {
  const out = resolveDrop(drop(), undefined, true);
  expect(out.status).toBe("not-started");
  expect(out.minutes).toBe(0);
});

test("absent from an UNAVAILABLE inventory means unknown, not zero", () => {
  // The whole reason InventorySnapshot carries `available`: a failed
  // fetch makes every drop absent, and reading that as not-started
  // would fill the page with confident zeros.
  expect(resolveDrop(drop(), undefined, false).status).toBe("unknown");
});

test("a zero-minute entry is not-started, not in-progress", () => {
  const out = resolveDrop(
    drop(),
    { minutes: 0, claimed: false, instanceId: null },
    true,
  );
  expect(out.status).toBe("not-started");
});

test("minutes are clamped to the requirement", () => {
  // Twitch keeps counting past the requirement; a bar reading 71/60
  // reads as a bug rather than a finished drop.
  const out = resolveDrop(
    drop(),
    { minutes: 71, claimed: false, instanceId: null },
    true,
  );
  expect(out.minutes).toBe(60);
});

test("a resolved drop carries its definition through", () => {
  const out = resolveDrop(
    drop({ name: "Charm", benefits: ["Charm"], requiredMinutes: 120 }),
    undefined,
    true,
  );
  expect(out).toMatchObject({
    id: "d1",
    name: "Charm",
    benefits: ["Charm"],
    requiredMinutes: 120,
  });
});

// --- campaign states ---

test("a campaign whose obtainable drops are all claimed is collected", () => {
  // The sub-gated drop is excluded from the verdict: it can never be
  // collected, so counting it would make the campaign permanently partial.
  const out = resolveCampaign(
    campaign([drop({ id: "d1" }), drop({ id: "d2", requiredSubs: 1 })]),
    snapshot({ c1: { d1: { minutes: 60, claimed: true, instanceId: "i" } } }),
  );
  expect(out.status).toBe("collected");
});

test("a campaign with some progress is partial", () => {
  const out = resolveCampaign(
    campaign([drop({ id: "d1" }), drop({ id: "d2" })]),
    snapshot({ c1: { d1: { minutes: 60, claimed: true, instanceId: "i" } } }),
  );
  expect(out.status).toBe("partial");
});

test("a campaign with a part-watched drop is partial", () => {
  const out = resolveCampaign(
    campaign([drop({ id: "d1" }), drop({ id: "d2" })]),
    snapshot({ c1: { d1: { minutes: 20, claimed: false, instanceId: null } } }),
  );
  expect(out.status).toBe("partial");
});

test("a campaign with no progress is untouched", () => {
  expect(resolveCampaign(campaign([drop()]), snapshot({})).status).toBe(
    "untouched",
  );
});

test("a campaign is unknown when the inventory is unavailable", () => {
  expect(resolveCampaign(campaign([drop()]), snapshot({}, false)).status).toBe(
    "unknown",
  );
});

test("a campaign of only sub-gated drops is untouched, never collected", () => {
  // Nothing here can be earned, so "collected" would be a false claim of
  // completion.
  const out = resolveCampaign(
    campaign([drop({ requiredSubs: 1 })]),
    snapshot({}),
  );
  expect(out.status).toBe("untouched");
});

test("a campaign with no drops at all is untouched", () => {
  expect(resolveCampaign(campaign([]), snapshot({})).status).toBe("untouched");
});

test("resolving a campaign keeps its metadata", () => {
  const out = resolveCampaign(campaign([drop()]), snapshot({}));
  expect(out).toMatchObject({
    id: "c1",
    name: "Campaign One",
    game: { displayName: "A Game" },
    endsAt: 9_000,
  });
  expect(out.drops).toHaveLength(1);
});

test("progress from another campaign is not attributed to this one", () => {
  const out = resolveCampaign(
    campaign([drop({ id: "d1" })]),
    snapshot({ c2: { d1: { minutes: 60, claimed: true, instanceId: "i" } } }),
  );
  expect(out.drops[0]?.status).toBe("not-started");
  expect(out.status).toBe("untouched");
});
