import { expect, test } from "vitest";
import { reconcile, type DesiredEntry } from "./reconcile.js";
import type { AppConfig } from "../config/schema.js";

type Streamer = AppConfig["streamers"][number];

const owned = (username: string, ownedBy: string): Streamer =>
  ({ username, enabled: true, settings: {}, ownedBy }) as Streamer;
const manual = (username: string): Streamer =>
  ({ username, enabled: true, settings: {} }) as Streamer;
const want = (username: string, ownedBy = "s1"): DesiredEntry =>
  ({ username, ownedBy });

test("no change when the desired set already matches", () => {
  const out = reconcile([manual("alpha"), owned("beta", "s1")], [want("beta")]);
  expect(out.changed).toBe(false);
});

test("adds a newly resolved channel", () => {
  const out = reconcile([manual("alpha")], [want("beta")]);
  expect(out.changed).toBe(true);
  expect(out.streamers.map((s) => s.username)).toEqual(["alpha", "beta"]);
});

test("removes a channel the subscription no longer wants", () => {
  const out = reconcile([manual("alpha"), owned("beta", "s1")], []);
  expect(out.changed).toBe(true);
  expect(out.streamers.map((s) => s.username)).toEqual(["alpha"]);
});

test("never touches hand-added streamers", () => {
  // The user's own roster is theirs; the engine owns only what it added.
  const out = reconcile([manual("alpha"), manual("gamma")], []);
  expect(out.changed).toBe(false);
  expect(out.streamers.map((s) => s.username)).toEqual(["alpha", "gamma"]);
});

test("reordering the desired pool is a change", () => {
  // Order is what upstream's priority_order consumes, so it is a real
  // difference in what the miner watches first.
  const out = reconcile(
    [owned("beta", "s1"), owned("gamma", "s1")],
    [want("gamma"), want("beta")],
  );
  expect(out.changed).toBe(true);
  expect(out.streamers.map((s) => s.username)).toEqual(["gamma", "beta"]);
});

test("a channel the user already follows is not duplicated", () => {
  // Their entry wins and keeps its own settings.
  const out = reconcile([manual("beta")], [want("beta")]);
  expect(out.changed).toBe(false);
  expect(out.streamers).toHaveLength(1);
  expect(out.streamers[0]?.ownedBy).toBeUndefined();
});

test("two subscriptions wanting the same channel add it once", () => {
  const out = reconcile([], [want("beta", "s1"), want("beta", "s2")]);
  expect(out.streamers).toHaveLength(1);
  // First writer wins, which is the higher-ranked subscription.
  expect(out.streamers[0]?.ownedBy).toBe("s1");
});

test("ownership transfers when a different subscription claims a channel", () => {
  const out = reconcile([owned("beta", "s1")], [want("beta", "s2")]);
  expect(out.changed).toBe(true);
  expect(out.streamers[0]?.ownedBy).toBe("s2");
});

test("owned entries sort after manual ones", () => {
  const out = reconcile([manual("alpha")], [want("beta")]);
  expect(out.streamers[0]?.username).toBe("alpha");
});

test("username comparison is case-insensitive", () => {
  const out = reconcile([owned("Beta", "s1")], [want("beta")]);
  expect(out.changed).toBe(false);
});

test("an owned entry keeps its settings across a re-resolve", () => {
  // A re-resolve must not silently reset a channel's configuration.
  const existing = {
    username: "beta", enabled: true,
    settings: { makePredictions: false }, ownedBy: "s1",
  } as Streamer;
  const out = reconcile([existing], [want("beta")]);
  expect(out.changed).toBe(false);
  expect(out.streamers[0]?.settings).toEqual({ makePredictions: false });
});

test("a new owned entry is enabled, or the miner would ignore it", () => {
  // build_streamers skips anything not enabled, so an added channel that
  // defaulted to disabled would be silently unwatched.
  const out = reconcile([], [want("beta")]);
  expect(out.streamers[0]?.enabled).toBe(true);
});

test("an empty desired set against an empty config is no change", () => {
  const out = reconcile([], []);
  expect(out.changed).toBe(false);
  expect(out.streamers).toEqual([]);
});

test("reports which channels were added and removed", () => {
  const out = reconcile(
    [owned("alpha", "s1"), owned("beta", "s1")],
    [{ username: "beta", ownedBy: "s1" }, { username: "gamma", ownedBy: "s1" }],
  );
  expect(out.added).toEqual(["gamma"]);
  expect(out.removed).toEqual(["alpha"]);
});

test("an unchanged pass added and removed nothing", () => {
  const out = reconcile(
    [owned("alpha", "s1")],
    [{ username: "alpha", ownedBy: "s1" }],
  );
  expect(out.changed).toBe(false);
  expect(out.added).toEqual([]);
  expect(out.removed).toEqual([]);
});

test("a pure reorder changes the config without adding or removing", () => {
  // Order is a real change -- priority_order consumes it -- but no
  // channel joined or left, and saying otherwise would misreport it.
  const out = reconcile(
    [owned("alpha", "s1"), owned("beta", "s1")],
    [{ username: "beta", ownedBy: "s1" }, { username: "alpha", ownedBy: "s1" }],
  );
  expect(out.changed).toBe(true);
  expect(out.added).toEqual([]);
  expect(out.removed).toEqual([]);
});
