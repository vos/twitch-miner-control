import { expect, test } from "vitest";
import type { StreamerState } from "../api/useLiveState.js";
import { sortStreamers } from "./sortStreamers.js";

/** Only the fields the comparators read; the rest never enters a sort. */
function streamer(over: Partial<StreamerState> & { username: string }): StreamerState {
  return {
    displayName: null, channelId: null, points: null, isOnline: null,
    pointsEnabled: null, gained24h: null, gainedSince: null, gainedStream: null,
    spark: [], avatarUrl: null, liveSince: null, streamId: null, lastLive: null,
    lastActivity: null, online24h: 0, mined24h: 0, minedTotal: 0,
    pointsPerHour: null, ...over,
  };
}

const names = (list: StreamerState[]) => list.map((s) => s.username);

test("default leaves the roster order untouched", () => {
  const roster = [streamer({ username: "carol" }), streamer({ username: "alice" })];
  expect(names(sortStreamers(roster, "default", "live"))).toEqual(["carol", "alice"]);
});

test("does not mutate the array it is given", () => {
  const roster = [streamer({ username: "carol" }), streamer({ username: "alice" })];
  sortStreamers(roster, "name", "live");
  expect(names(roster)).toEqual(["carol", "alice"]);
});

test("name sorts A to Z", () => {
  const roster = [streamer({ username: "carol" }), streamer({ username: "alice" })];
  expect(names(sortStreamers(roster, "name", "live"))).toEqual(["alice", "carol"]);
});

test("name prefers the display name over the login", () => {
  // The card renders displayName, so sorting by username would order the
  // list by a string the user cannot see.
  const roster = [
    streamer({ username: "aaa", displayName: "Zoe" }),
    streamer({ username: "zzz", displayName: "Adam" }),
  ];
  expect(names(sortStreamers(roster, "name", "live"))).toEqual(["zzz", "aaa"]);
});

test("name ignores case", () => {
  const roster = [streamer({ username: "Bravo" }), streamer({ username: "alpha" })];
  expect(names(sortStreamers(roster, "name", "live"))).toEqual(["alpha", "Bravo"]);
});

test("gain sorts the biggest earner first", () => {
  const roster = [
    streamer({ username: "small", gained24h: 10 }),
    streamer({ username: "big", gained24h: 900 }),
    streamer({ username: "mid", gained24h: 100 }),
  ];
  expect(names(sortStreamers(roster, "gain", "live"))).toEqual(["big", "mid", "small"]);
});

// A channel with no baseline yet is not a channel that earned nothing --
// sorting it as 0 would rank it above every genuine loss and bury it among
// real figures, when what it actually has is no answer.
test("gain sinks streamers with no baseline below every known figure", () => {
  const roster = [
    streamer({ username: "unknown", gained24h: null }),
    streamer({ username: "negative", gained24h: -50 }),
  ];
  expect(names(sortStreamers(roster, "gain", "live"))).toEqual(["negative", "unknown"]);
});

test("recent sorts live streamers by longest-running stream first", () => {
  const roster = [
    streamer({ username: "justStarted", liveSince: 5_000 }),
    streamer({ username: "allDay", liveSince: 1_000 }),
  ];
  expect(names(sortStreamers(roster, "recent", "live"))).toEqual(["allDay", "justStarted"]);
});

test("recent sorts offline streamers by most recently live first", () => {
  const roster = [
    streamer({ username: "lastWeek", lastLive: 1_000 }),
    streamer({ username: "justOffline", lastLive: 9_000 }),
  ];
  expect(names(sortStreamers(roster, "recent", "offline")))
    .toEqual(["justOffline", "lastWeek"]);
});

test("recent sinks streamers never seen live", () => {
  const roster = [
    streamer({ username: "neverSeen", lastLive: null }),
    streamer({ username: "lastWeek", lastLive: 1_000 }),
  ];
  expect(names(sortStreamers(roster, "recent", "offline")))
    .toEqual(["lastWeek", "neverSeen"]);
});

// Ties must never reshuffle between SSE frames: the dashboard re-renders
// every poll, and cards swapping places under the cursor is exactly the
// jitter a stable fallback to roster order prevents.
test("ties keep their roster order", () => {
  const roster = [
    streamer({ username: "third", gained24h: 5 }),
    streamer({ username: "first", gained24h: 5 }),
    streamer({ username: "second", gained24h: 5 }),
  ];
  expect(names(sortStreamers(roster, "gain", "live")))
    .toEqual(["third", "first", "second"]);
});

test("an unknown key falls back to roster order", () => {
  // A hand-edited localStorage value must not blank or scramble the grid.
  const roster = [streamer({ username: "carol" }), streamer({ username: "alice" })];
  expect(names(sortStreamers(roster, "nonsense" as never, "live")))
    .toEqual(["carol", "alice"]);
});
