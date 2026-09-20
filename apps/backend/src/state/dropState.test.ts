import { expect, test } from "vitest";
import { resolveCampaign, resolveDrop } from "./dropState.js";
import type { Campaign, CampaignDrop } from "./campaignCatalogue.js";
import type {
  EarnedMap, InventoryMap, InventorySnapshot,
} from "./inventory.js";

const drop = (over: Partial<CampaignDrop> = {}): CampaignDrop => ({
  id: "d1",
  name: "Crate",
  benefits: [{ name: "Crate", imageUrl: "https://cdn/crate.png" }],
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
  drops,
});

const snapshot = (
  progress: InventoryMap,
  available = true,
  earned: EarnedMap = {},
): InventorySnapshot => ({ progress, earned, fetchedAt: 1_000, available });

// --- drop states ---

test("a drop Twitch marks sub-gated is unobtainable", () => {
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

test("a drop requiring no watch time is unobtainable", () => {
  // The tracker never sets requiresSub -- it is false on every drop in
  // the live feed -- so zero required minutes is what actually catches a
  // drop gated behind something other than watching (a sub, a gift sub,
  // an external hunt). A drop earnable by watching must cost some watching.
  expect(resolveDrop(drop({ requiredMinutes: 0 }), undefined, true).status)
    .toBe("unobtainable");
});

test("a zero-minute drop is unobtainable even with recorded progress", () => {
  const out = resolveDrop(
    drop({ requiredMinutes: 0 }),
    { minutes: 0, claimed: false, instanceId: null },
    true,
  );
  expect(out.status).toBe("unobtainable");
});

test("a drop Twitch reports preconditions unmet for is unobtainable", () => {
  // Twitch's own verdict, from the Inventory query's self edge. It is
  // the authoritative signal where it exists: the drop is in progress,
  // costs watch time, and is still blocked on something else.
  const out = resolveDrop(
    drop(),
    { minutes: 30, claimed: false, instanceId: null, preconditionsMet: false },
    true,
  );
  expect(out.status).toBe("unobtainable");
});

test("preconditions met leaves an ordinary drop alone", () => {
  const out = resolveDrop(
    drop(),
    { minutes: 30, claimed: false, instanceId: null, preconditionsMet: true },
    true,
  );
  expect(out.status).toBe("in-progress");
});

test("an unreported precondition is not read as unmet", () => {
  // Null means the source did not say -- a helper predating the field,
  // or a catalogue-only drop. Treating silence as "blocked" would mark
  // every ordinary drop unobtainable.
  const out = resolveDrop(
    drop(),
    { minutes: 30, claimed: false, instanceId: null, preconditionsMet: null },
    true,
  );
  expect(out.status).toBe("in-progress");
});

test("a claimed drop stays claimed despite unmet preconditions", () => {
  // Already in hand: whatever the gate was, it was passed. Reporting it
  // unobtainable would take a reward off the viewer's own tally.
  const out = resolveDrop(
    drop(),
    { minutes: 60, claimed: true, instanceId: "i1", preconditionsMet: false },
    true,
  );
  expect(out.status).toBe("claimed");
});

test("a claimable drop stays claimable despite unmet preconditions", () => {
  // Twitch minted an instance: it is sitting there to be collected, so
  // the gate cannot still be closed.
  const out = resolveDrop(
    drop(),
    { minutes: 60, claimed: false, instanceId: "i1", preconditionsMet: false },
    true,
  );
  expect(out.status).toBe("claimable");
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
    drop({
      name: "Charm",
      benefits: [{ name: "Charm", imageUrl: null }],
      requiredMinutes: 120,
    }),
    undefined,
    true,
  );
  expect(out).toMatchObject({
    id: "d1",
    name: "Charm",
    benefits: [{ name: "Charm", imageUrl: null }],
    requiredMinutes: 120,
  });
});

test("a drop with no window of its own reports null rather than omitting it", () => {
  // A catalogue persisted before these were parsed has no dates on its
  // drops; the API shape stays the same either way.
  const out = resolveDrop(drop({ startsAt: undefined, endsAt: undefined }), undefined, true);
  expect(out.startsAt).toBeNull();
  expect(out.endsAt).toBeNull();
});

test("a drop's own window is carried through to the card", () => {
  const out = resolveDrop(
    drop({ startsAt: 5_000, endsAt: 6_000 }),
    undefined,
    true,
  );
  expect(out).toMatchObject({ startsAt: 5_000, endsAt: 6_000 });
});

// --- campaign states ---

test("a campaign whose obtainable drops are all claimed is collected", () => {
  // The unobtainable drop is excluded from the verdict: it can never be
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

test("a campaign of only unobtainable drops is untouched, never collected", () => {
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

// --- campaigns finished and gone from the inventory ---

test("a drop whose reward was claimed is claimed, not not-started", () => {
  // The bug this exists to stop: `dropCampaignsInProgress` means what it
  // says, so a campaign whose drops are ALL claimed leaves it entirely.
  // Read on absence alone every drop looked untouched and the card
  // badged a finished campaign "not started".
  const out = resolveDrop(drop({ id: "d1" }), undefined, true, ["Crate"]);
  expect(out.status).toBe("claimed");
});

test("a claimed reward reports the drop's full watch time", () => {
  // The reward is proof the requirement was met; reporting 0 minutes
  // would draw an empty bar under a drop that is finished.
  const out = resolveDrop(drop({ requiredMinutes: 60 }), undefined, true, ["Crate"]);
  expect(out.minutes).toBe(60);
});

test("a campaign gone from the inventory but fully claimed is collected", () => {
  const out = resolveCampaign(
    campaign([drop({ id: "d1" }), drop({ id: "d2", benefits: [{ name: "Charm", imageUrl: null }] })]),
    snapshot({}, true, { c1: ["Crate", "Charm"] }),
  );
  expect(out.status).toBe("collected");
  expect(out.drops.map((d) => d.status)).toEqual(["claimed", "claimed"]);
});

test("rewards claimed in another campaign are not attributed to this one", () => {
  const out = resolveCampaign(
    campaign([drop({ id: "d1" })]),
    snapshot({}, true, { c2: ["Crate"] }),
  );
  expect(out.drops[0]?.status).toBe("not-started");
  expect(out.status).toBe("untouched");
});

test("a campaign with only some rewards claimed is partial", () => {
  const out = resolveCampaign(
    campaign([drop({ id: "d1" }), drop({ id: "d2", benefits: [{ name: "Charm", imageUrl: null }] })]),
    snapshot({}, true, { c1: ["Crate"] }),
  );
  expect(out.status).toBe("partial");
});

test("live progress wins over a claimed reward of the same drop", () => {
  // Both halves can describe one drop while a campaign is still running.
  // The inventory entry is the more specific fact -- it carries minutes
  // and an instance id -- so it must not be overwritten by name matching.
  const out = resolveDrop(
    drop(),
    { minutes: 60, claimed: false, instanceId: "i1" },
    true,
    ["Crate"],
  );
  expect(out.status).toBe("claimable");
});

test("an unobtainable drop stays so even with a claimed reward", () => {
  // Unobtainable overrides everything, as it does for live progress: a
  // reward sharing its name must not resurrect a drop watching cannot earn.
  const out = resolveDrop(drop({ requiredSubs: 1 }), undefined, true, ["Crate"]);
  expect(out.status).toBe("unobtainable");
});

test("a campaign whose only unclaimed drop is unobtainable is collected", () => {
  // The Dawnwalker case: a 60m drop claimed, and a zero-minute
  // "Supporter" drop gated behind a gift sub. Counting the gated one
  // leaves the campaign permanently "partial" at 100% watched.
  const out = resolveCampaign(
    campaign([
      drop({ id: "d1", name: "Launch", requiredMinutes: 60 }),
      drop({ id: "d2", name: "Supporter", requiredMinutes: 0 }),
    ]),
    snapshot({ c1: { d1: { minutes: 60, claimed: true, instanceId: "i1" } } }),
  );
  expect(out.status).toBe("collected");
});

test("claimed rewards are ignored when the inventory is unavailable", () => {
  // A failed fetch reports no rewards either, so trusting the empty list
  // would badge every finished campaign as untouched.
  const out = resolveCampaign(campaign([drop()]), snapshot({}, false, {}));
  expect(out.status).toBe("unknown");
});

test("a drop with no benefits is unaffected by claimed rewards", () => {
  // Nothing to match on; it must not match everything.
  const out = resolveDrop(drop({ benefits: [] }), undefined, true, ["Crate"]);
  expect(out.status).toBe("not-started");
});
