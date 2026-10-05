import { expect, test } from "vitest";
import { resolveSubscription, type DirectoryChannel } from "./resolution.js";
import type { Campaign } from "../state/campaignCatalogue.js";
import type { Subscription } from "../config/schema.js";

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: "s1", targetId: "c1",
  label: "Alpha", poolSize: 3, rank: 0, ...over,
});

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: "c1", name: "Alpha",
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1, endsAt: 2, drops: [], ...over,
});

const chan = (login: string, viewers: number): DirectoryChannel =>
  ({ login, channelId: `id-${login}`, viewers });

test("picks the most watched channels for the game", () => {
  const out = resolveSubscription(sub(), campaign(), [
    chan("alpha", 10), chan("beta", 500), chan("gamma", 90),
  ]);
  expect(out.channels).toEqual(["beta", "gamma", "alpha"]);
  expect(out.degraded).toBe(false);
});

test("the pool is capped at poolSize", () => {
  const out = resolveSubscription(sub({ poolSize: 2 }), campaign(), [
    chan("alpha", 10), chan("beta", 500), chan("gamma", 90),
  ]);
  expect(out.channels).toEqual(["beta", "gamma"]);
});

test("fewer live channels than the pool size is not a failure", () => {
  const out = resolveSubscription(sub({ poolSize: 5 }), campaign(), [
    chan("alpha", 10),
  ]);
  expect(out.channels).toEqual(["alpha"]);
  expect(out.degraded).toBe(false);
});

test("nobody live is a real answer, not a degraded one", () => {
  // The query succeeded and told us the truth: no one is streaming it.
  const out = resolveSubscription(sub(), campaign(), []);
  expect(out.channels).toEqual([]);
  expect(out.degraded).toBe(false);
});

test("an unavailable directory degrades rather than emptying the pool", () => {
  // Emptying it would quietly stop drop collection with no visible
  // cause; degraded tells the caller to keep what it has.
  const out = resolveSubscription(sub(), campaign(), null);
  expect(out.degraded).toBe(true);
  expect(out.channels).toEqual([]);
});

test("an unknown campaign degrades", () => {
  const out = resolveSubscription(sub(), undefined, [chan("alpha", 10)]);
  expect(out.degraded).toBe(true);
  expect(out.channels).toEqual([]);
});

test("a campaign with no game reported degrades", () => {
  // The directory is keyed by game; without one there is nothing to ask.
  const out = resolveSubscription(sub(), campaign({ game: null }), [
    chan("alpha", 10),
  ]);
  expect(out.degraded).toBe(true);
});

test("ties break by login so the pool is stable across passes", () => {
  // An unstable order would rewrite the config and restart the miner on
  // a pass where nothing actually changed.
  const out = resolveSubscription(sub({ poolSize: 2 }), campaign(), [
    chan("zeta", 50), chan("alpha", 50), chan("beta", 50),
  ]);
  expect(out.channels).toEqual(["alpha", "beta"]);
});

test("live incumbents keep their slots and their order", () => {
  // The whole point of a pool: while a member is still live it carries
  // the drop, so re-ranking it by viewers buys nothing and costs a
  // restart. Upstream's priority_order reads this order, but honouring a
  // viewer shuffle is not worth the miner's accumulated session state.
  const out = resolveSubscription(sub(), campaign(), [
    chan("gamma", 900), chan("beta", 500), chan("alpha", 10),
  ], ["alpha", "beta", "gamma"]);
  expect(out.channels).toEqual(["alpha", "beta", "gamma"]);
  expect(out.degraded).toBe(false);
});

test("a pool with one live member left is left alone, offline members and all", () => {
  // One live streamer still makes progress. Topping the pool back up
  // would restart the miner to buy resilience we do not need yet -- and
  // the offline members stay in the list so the miner resumes them by
  // itself when they come back.
  const out = resolveSubscription(sub(), campaign(), [
    chan("alpha", 10), chan("delta", 900), chan("epsilon", 800),
  ], ["alpha", "beta", "gamma"]);
  expect(out.channels).toEqual(["alpha", "beta", "gamma"]);
});

test("a dead pool is rebuilt from the directory", () => {
  // No incumbent is live, so nothing is collecting -- this is the one
  // case where a rebuild and its restart are worth paying for.
  const out = resolveSubscription(sub(), campaign(), [
    chan("delta", 900), chan("epsilon", 800), chan("zeta", 700),
  ], ["alpha", "beta", "gamma"]);
  expect(out.channels).toEqual(["delta", "epsilon", "zeta"]);
});

test("an empty pool resolves fresh rather than counting as dead-but-kept", () => {
  // A brand new subscription owns nothing yet; it must fill.
  const out = resolveSubscription(sub(), campaign(), [
    chan("delta", 900), chan("epsilon", 800),
  ], []);
  expect(out.channels).toEqual(["delta", "epsilon"]);
});

test("incumbents are matched regardless of login casing", () => {
  const out = resolveSubscription(sub(), campaign(), [
    chan("alpha", 10), chan("delta", 900),
  ], ["Alpha", "beta"]);
  // Still live, so the pool holds -- and keeps the config's spelling.
  expect(out.channels).toEqual(["Alpha", "beta"]);
});


test("a kept pool reports the decision and how many were live", () => {
  // The evidence behind the decision, so a reader can check it rather
  // than take it on trust.
  const out = resolveSubscription(sub(), campaign(), [
    chan("alpha", 10), chan("beta", 20), chan("delta", 900),
  ], ["alpha", "beta", "gamma"]);
  expect(out.decision).toBe("kept");
  expect(out.liveCount).toBe(2);
});

test("a rebuilt pool reports nobody was live", () => {
  const out = resolveSubscription(sub(), campaign(), [
    chan("delta", 900),
  ], ["alpha", "beta", "gamma"]);
  expect(out.decision).toBe("rebuilt");
  expect(out.liveCount).toBe(0);
});

test("a fresh subscription rebuilds rather than keeping nothing", () => {
  const out = resolveSubscription(sub(), campaign(), [chan("delta", 900)], []);
  expect(out.decision).toBe("rebuilt");
});

test("the two degraded causes are told apart", () => {
  // "We could not reach the directory" and "this campaign has no game"
  // need different reactions from a reader, so they are different
  // decisions rather than one degraded flag.
  expect(resolveSubscription(sub(), campaign(), null, []).decision)
    .toBe("directory-failed");
  expect(resolveSubscription(sub(), undefined, [chan("a", 1)], []).decision)
    .toBe("no-target");
});

test("a degraded result reports no live count at all", () => {
  // Not zero: zero would claim we looked and found nobody live, which is
  // the opposite of what happened.
  expect(resolveSubscription(sub(), campaign(), null, ["alpha"]).liveCount)
    .toBeUndefined();
});

test("a forced rebuild ignores live incumbents", () => {
  const out = resolveSubscription(
    sub({ poolSize: 2 }), campaign(),
    [chan("alpha", 10), chan("beta", 500), chan("gamma", 90)],
    ["alpha"], { rebuild: true },
  );
  expect(out.decision).toBe("rebuilt");
  expect(out.channels).toEqual(["beta", "gamma"]);
  // Still the evidence, so a log can say the pool was not dead.
  expect(out.liveCount).toBe(1);
});

test("a rebuild passes over excluded channels", () => {
  const out = resolveSubscription(
    sub({ poolSize: 2 }), campaign(),
    [chan("alpha", 10), chan("beta", 500), chan("gamma", 90)],
    ["beta"], { rebuild: true, exclude: new Set(["beta"]) },
  );
  expect(out.channels).toEqual(["gamma", "alpha"]);
});

test("a rebuild with everyone excluded falls back to the whole directory", () => {
  // An empty pool stops collection invisibly; a pool that may not help
  // at least keeps the stall detector watching it.
  const out = resolveSubscription(
    sub({ poolSize: 1 }), campaign(), [chan("beta", 500)],
    ["beta"], { rebuild: true, exclude: new Set(["beta"]) },
  );
  expect(out.channels).toEqual(["beta"]);
});

test("a rebuild prefers channels confirmed to carry the campaign", () => {
  const out = resolveSubscription(
    sub({ poolSize: 2 }), campaign(),
    [chan("alpha", 10), chan("beta", 500), chan("gamma", 90), chan("delta", 5)],
    [],
    { carries: new Map([["beta", false], ["gamma", true], ["alpha", false]]) },
  );
  // gamma is confirmed; delta was never checked, so it may still carry
  // it; beta and alpha were checked and do not.
  expect(out.channels).toEqual(["gamma", "delta"]);
});

test("a check that confirms nobody leaves the ranking as it was", () => {
  const out = resolveSubscription(
    sub({ poolSize: 2 }), campaign(),
    [chan("alpha", 10), chan("beta", 500)],
    [], { carries: new Map([["beta", false], ["alpha", false]]) },
  );
  expect(out.channels).toEqual(["beta", "alpha"]);
});

test("the campaign check plays no part in keeping a live pool", () => {
  const out = resolveSubscription(
    sub(), campaign(), [chan("alpha", 10), chan("beta", 500)],
    ["alpha"], { carries: new Map([["alpha", false]]) },
  );
  expect(out.decision).toBe("kept");
});
