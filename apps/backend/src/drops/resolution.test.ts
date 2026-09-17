import { expect, test } from "vitest";
import { resolveSubscription, type DirectoryChannel } from "./resolution.js";
import type { Campaign } from "../state/campaignCatalogue.js";
import type { Subscription } from "../config/schema.js";

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: "s1", kind: "campaign", targetId: "c1",
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

test("a game subscription resolves without needing a campaign", () => {
  // Subscribing to a game is not tied to any one campaign's lifetime.
  const out = resolveSubscription(
    sub({ kind: "game", targetId: "g1", label: "A Game" }),
    undefined,
    [chan("alpha", 10), chan("beta", 500)],
  );
  expect(out.channels).toEqual(["beta", "alpha"]);
  expect(out.degraded).toBe(false);
});
