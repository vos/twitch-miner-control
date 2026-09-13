import { beforeEach, expect, test } from "vitest";
import { openDb } from "./schema.js";
import { Streamers } from "./streamers.js";

let streamers: Streamers;
beforeEach(() => { streamers = new Streamers(openDb(":memory:")); });

test("returns no rows for logins never seen", () => {
  expect(streamers.get(["alpha"]).size).toBe(0);
});

test("records the first sighting of a streamer", () => {
  streamers.see("alpha", 1000);
  expect(streamers.get(["alpha"]).get("alpha")).toMatchObject({
    login: "alpha", firstSeenTs: 1000, lastSeenTs: 1000,
  });
});

test("keeps the first sighting when seen again", () => {
  // The whole point of the column: a later poll must not move the floor
  // forward, or mining time would restart from zero on every tick.
  streamers.see("alpha", 1000);
  streamers.see("alpha", 5000);
  const row = streamers.get(["alpha"]).get("alpha");
  expect(row?.firstSeenTs).toBe(1000);
  expect(row?.lastSeenTs).toBe(5000);
});

test("firstSeen reports null for a streamer never seen", () => {
  expect(streamers.firstSeen("ghost")).toBeNull();
});

test("firstSeen reports the recorded sighting", () => {
  streamers.see("alpha", 1000);
  expect(streamers.firstSeen("alpha")).toBe(1000);
});

test("tracks streamers independently", () => {
  streamers.see("alpha", 1000);
  streamers.see("beta", 4000);
  expect(streamers.firstSeen("alpha")).toBe(1000);
  expect(streamers.firstSeen("beta")).toBe(4000);
});

test("records the display name alongside the sighting", () => {
  streamers.see("alpha", 1000, "Alpha");
  expect(streamers.get(["alpha"]).get("alpha")).toMatchObject({
    login: "alpha", displayName: "Alpha",
  });
});

test("keeps the last known display name when a poll reports none", () => {
  // state.py returns displayName null for a channel whose community block
  // is missing -- an errored or unresolvable poll. The card falls back to
  // the raw login, so a name we once resolved must survive the gap rather
  // than flipping the card to lowercase.
  streamers.see("alpha", 1000, "Alpha");
  streamers.see("alpha", 2000, null);
  expect(streamers.get(["alpha"]).get("alpha")?.displayName).toBe("Alpha");
});

test("updates the display name when the streamer renames", () => {
  // A real rename must still win: the guard above is for missing data,
  // not for pinning the first name we ever saw.
  streamers.see("alpha", 1000, "Alpha");
  streamers.see("alpha", 2000, "AlphaTV");
  expect(streamers.get(["alpha"]).get("alpha")?.displayName).toBe("AlphaTV");
});

test("a sighting without a display name leaves it null", () => {
  streamers.see("alpha", 1000);
  expect(streamers.get(["alpha"]).get("alpha")?.displayName).toBeNull();
});

test("stores and reads back an avatar", () => {
  streamers.see("alpha", 1000);
  streamers.putProfile("alpha", "https://cdn/a.png", 2000);
  expect(streamers.get(["alpha"]).get("alpha")).toMatchObject({
    login: "alpha", avatarUrl: "https://cdn/a.png", fetchedAt: 2000,
  });
});

test("a stored null avatar is a row, not an absence", () => {
  // "we asked and there is no avatar" must stay distinguishable from
  // "we never asked", or an avatarless channel is re-fetched forever.
  streamers.putProfile("alpha", null, 1000);
  expect(streamers.get(["alpha"]).get("alpha")).toMatchObject({
    login: "alpha", avatarUrl: null, fetchedAt: 1000,
  });
});

test("putProfile replaces an existing row rather than duplicating it", () => {
  streamers.putProfile("alpha", "https://cdn/old.png", 1000);
  streamers.putProfile("alpha", "https://cdn/new.png", 2000);
  const found = streamers.get(["alpha"]);
  expect(found.size).toBe(1);
  expect(found.get("alpha")).toMatchObject({
    avatarUrl: "https://cdn/new.png", fetchedAt: 2000,
  });
});

test("putProfile does not disturb an existing first sighting", () => {
  // The avatar refreshes weekly; the sighting floor must survive it.
  streamers.see("alpha", 1000);
  streamers.putProfile("alpha", "https://cdn/a.png", 9000);
  expect(streamers.firstSeen("alpha")).toBe(1000);
});

test("an avatar stored before any sighting leaves the floor unset", () => {
  // putProfile can land first: the profile pass and the state pass are
  // separate clocks. It must not invent a sighting time of its own --
  // the row exists, but nothing claims we have watched the channel.
  streamers.putProfile("alpha", "https://cdn/a.png", 9000);
  expect(streamers.firstSeen("alpha")).toBeNull();
  streamers.see("alpha", 1000);
  expect(streamers.firstSeen("alpha")).toBe(1000);
});

test("get reads many logins at once and omits the unknown ones", () => {
  streamers.see("alpha", 1000);
  streamers.putProfile("beta", null, 1000);
  const found = streamers.get(["alpha", "beta", "gamma"]);
  expect([...found.keys()].sort()).toEqual(["alpha", "beta"]);
});

test("get with no logins does not query", () => {
  streamers.see("alpha", 1000);
  expect(streamers.get([]).size).toBe(0);
});
