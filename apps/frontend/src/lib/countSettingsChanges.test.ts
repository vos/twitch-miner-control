import { expect, test } from "vitest";
import { countChanges } from "./countSettingsChanges.js";

test("an unchanged config has nothing pending", () => {
  const config = { followers: false, defaults: { claimDrops: true }, miner: {} };
  expect(countChanges(config, structuredClone(config))).toBe(0);
});

test("key order is not a change", () => {
  // `withKey` deletes and re-appends, so a reverted field arrives with its
  // keys in a different order than the saved config has them.
  const before = { defaults: { makePredictions: true, claimDrops: false } };
  const after = { defaults: { claimDrops: false, makePredictions: true } };
  expect(countChanges(before, after)).toBe(0);
});

test("editing a default and reverting it leaves nothing pending", () => {
  const saved = { defaults: { claimDrops: true, watchStreak: true } };
  // What the UI produces: toggle off, then back on.
  const toggled = { defaults: { watchStreak: true, claimDrops: false } };
  const reverted = { defaults: { watchStreak: true, claimDrops: true } };

  expect(countChanges(saved, toggled)).toBe(1);
  expect(countChanges(saved, reverted)).toBe(0);
});

test("counts each changed setting, not just that something changed", () => {
  const before = { followers: false, followersOrder: "ASC", defaults: { claimDrops: true } };
  const after = { followers: true, followersOrder: "DESC", defaults: { claimDrops: false } };
  expect(countChanges(before, after)).toBe(3);
});

test("counts changes nested inside the miner objects", () => {
  const before = { miner: { gql: { attempts: 3, attemptIntervalSeconds: 1 } } };
  const after = { miner: { gql: { attempts: 5, attemptIntervalSeconds: 2 } } };
  expect(countChanges(before, after)).toBe(2);
});

test("adding or removing a key counts as one change", () => {
  expect(countChanges({ miner: {} }, { miner: { claimDropsStartup: true } })).toBe(1);
  expect(countChanges({ miner: { claimDropsStartup: true } }, { miner: {} })).toBe(1);
});

test("an ordered priority list counts as a single change", () => {
  // It is one ranking the user rearranged, not N independent settings.
  const before = { miner: { priority: ["ORDER", "DROPS"] } };
  const after = { miner: { priority: ["DROPS", "ORDER"] } };
  expect(countChanges(before, after)).toBe(1);
});

test("swapping an object for a scalar is one change", () => {
  // weeklyRewards has three states: absent, false, or an options object.
  expect(countChanges({ m: { weeklyRewards: {} } }, { m: { weeklyRewards: false } })).toBe(1);
});
