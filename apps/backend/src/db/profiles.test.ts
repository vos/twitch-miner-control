import { beforeEach, expect, test } from "vitest";
import { openDb } from "./schema.js";
import { Profiles } from "./profiles.js";

let profiles: Profiles;
beforeEach(() => { profiles = new Profiles(openDb(":memory:")); });

test("returns no rows for logins never stored", () => {
  expect(profiles.get(["alpha"]).size).toBe(0);
});

test("stores and reads back a url", () => {
  profiles.put("alpha", "https://cdn/a.png", 1000);
  expect(profiles.get(["alpha"]).get("alpha")).toEqual({
    login: "alpha", avatarUrl: "https://cdn/a.png", fetchedAt: 1000,
  });
});

test("a stored null is a row, not an absence", () => {
  // "we asked and there is no avatar" must be distinguishable from
  // "we never asked", or a channel without an avatar is re-fetched forever.
  profiles.put("alpha", null, 1000);
  const row = profiles.get(["alpha"]).get("alpha");
  expect(row).toEqual({ login: "alpha", avatarUrl: null, fetchedAt: 1000 });
});

test("put replaces an existing row rather than duplicating it", () => {
  profiles.put("alpha", "https://cdn/old.png", 1000);
  profiles.put("alpha", "https://cdn/new.png", 2000);
  const found = profiles.get(["alpha"]);
  expect(found.size).toBe(1);
  expect(found.get("alpha")).toEqual({
    login: "alpha", avatarUrl: "https://cdn/new.png", fetchedAt: 2000,
  });
});

test("get reads many logins at once and omits the unknown ones", () => {
  profiles.put("alpha", "https://cdn/a.png", 1000);
  profiles.put("beta", null, 1000);
  const found = profiles.get(["alpha", "beta", "gamma"]);
  expect([...found.keys()].sort()).toEqual(["alpha", "beta"]);
});

test("get with no logins does not query", () => {
  profiles.put("alpha", "https://cdn/a.png", 1000);
  expect(profiles.get([]).size).toBe(0);
});
