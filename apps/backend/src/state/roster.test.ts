import { expect, test, vi } from "vitest";
import { resolveRoster } from "./roster.js";

function make(over: Partial<Parameters<typeof resolveRoster>[0]> = {}) {
  return {
    configured: () => ["kdrkitten", "zarbex"],
    followersEnabled: () => true,
    fetchFollowers: async () => [
      "streamerhouse", "zarbex", "trymacs", "montanablack88", "kdrkitten",
    ],
    ...over,
  };
}

test("unions configured streamers with followed channels", async () => {
  expect(await resolveRoster(make())).toEqual([
    "kdrkitten", "zarbex", "streamerhouse", "trymacs", "montanablack88",
  ]);
});

test("a channel in both lists appears exactly once", async () => {
  const roster = await resolveRoster(make());
  expect(roster.filter((n) => n === "zarbex")).toHaveLength(1);
  expect(roster.filter((n) => n === "kdrkitten")).toHaveLength(1);
});

test("dedupes case- and space-insensitively, as the miner does", async () => {
  const roster = await resolveRoster(make({
    configured: () => ["KDRkitten"],
    fetchFollowers: async () => [" kdr kitten ", "trymacs"],
  }));
  expect(roster).toEqual(["KDRkitten", "trymacs"]);
});

test("keeps the configured spelling and order when both lists have it", async () => {
  const roster = await resolveRoster(make({
    configured: () => ["ZARBEX"],
    fetchFollowers: async () => ["zarbex"],
  }));
  expect(roster).toEqual(["ZARBEX"]);
});

test("ignores followers entirely when the setting is off", async () => {
  const fetchFollowers = vi.fn(async () => ["trymacs"]);
  const roster = await resolveRoster(make({
    followersEnabled: () => false,
    fetchFollowers,
  }));
  expect(roster).toEqual(["kdrkitten", "zarbex"]);
  expect(fetchFollowers).not.toHaveBeenCalled();
});

test("degrades to the configured list when the follower fetch fails", async () => {
  const onError = vi.fn();
  const roster = await resolveRoster(make({
    fetchFollowers: async () => { throw new Error("401 Unauthorized"); },
    onError,
  }));
  expect(roster).toEqual(["kdrkitten", "zarbex"]);
  expect(onError).toHaveBeenCalledOnce();
});

test("drops blank names rather than polling an empty login", async () => {
  const roster = await resolveRoster(make({
    configured: () => ["alpha", "  "],
    fetchFollowers: async () => [""],
  }));
  expect(roster).toEqual(["alpha"]);
});
