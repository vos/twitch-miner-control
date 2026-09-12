import { expect, test } from "vitest";
import { dropsEligible } from "./dropsEligible.js";

const config = (over: object = {}) => ({
  defaults: {},
  streamers: [{ username: "alpha", enabled: true, settings: {} }],
  ...over,
} as never);

test("a streamer inherits claimDrops from the defaults", () => {
  expect(dropsEligible(config({ defaults: { claimDrops: true } }), "alpha")).toBe(true);
  expect(dropsEligible(config({ defaults: { claimDrops: false } }), "alpha")).toBe(false);
});

test("a streamer's own setting overrides the default", () => {
  const cfg = config({
    defaults: { claimDrops: false },
    streamers: [{ username: "alpha", enabled: true, settings: { claimDrops: true } }],
  });
  expect(dropsEligible(cfg, "alpha")).toBe(true);
});

test("a streamer can opt out of a default that is on", () => {
  const cfg = config({
    defaults: { claimDrops: true },
    streamers: [{ username: "alpha", enabled: true, settings: { claimDrops: false } }],
  });
  expect(dropsEligible(cfg, "alpha")).toBe(false);
});

test("matches the roster's normalisation rather than the raw spelling", () => {
  // A config entry spelled "Alpha" and a live-state row spelled "alpha"
  // are one channel; missing the match would silently disable drops.
  const cfg = config({
    defaults: { claimDrops: true },
    streamers: [{ username: "Alpha", enabled: true, settings: {} }],
  });
  expect(dropsEligible(cfg, "alpha")).toBe(true);
});

test("a followed channel with no config entry falls back to the defaults", () => {
  // "Mine my followed channels" adds logins that were never configured;
  // the miner applies the defaults to them, so this must agree.
  expect(dropsEligible(config({ defaults: { claimDrops: true } }), "ghost")).toBe(true);
});

test("claimDrops unset anywhere follows the miner and defaults on", () => {
  // Upstream's Streamer.default() sets claim_drops = True when it is
  // None, so an unconfigured channel IS having its drops claimed. The
  // dashboard reading absent as "off" made it report no drops for every
  // streamer in a default config, contradicting the miner beside it.
  expect(dropsEligible(config(), "alpha")).toBe(true);
});

test("an explicit false still wins over the default-on", () => {
  const cfg = config({
    streamers: [{ username: "alpha", enabled: true, settings: { claimDrops: false } }],
  });
  expect(dropsEligible(cfg, "alpha")).toBe(false);
});

test("a default of false applies to a streamer that sets nothing", () => {
  expect(dropsEligible(config({ defaults: { claimDrops: false } }), "alpha")).toBe(false);
});
