import { expect, test } from "vitest";
import type { ScreenKey } from "../app.js";
import type { ResolvedCampaign } from "../components/CampaignCard.js";
import { GROUP_LIMIT, buildPalette, type PaletteInput } from "./palette.js";

const NOW = 1_800_000_000_000;

const screens: PaletteInput["screens"] = [
  { key: "dashboard" as ScreenKey, label: "Dashboard" },
  { key: "streamers" as ScreenKey, label: "Streamers" },
  { key: "logs" as ScreenKey, label: "Logs" },
];

const streamers: PaletteInput["streamers"] = [
  { username: "alpha", displayName: "Alpha", isOnline: true, viewers: 100 },
  { username: "beta", displayName: "Beta", isOnline: false, viewers: null },
  { username: "betamax", displayName: "BetaMax", isOnline: true, viewers: 5000 },
];

const campaign = (id: string, name: string, extra: Partial<ResolvedCampaign> = {}) => ({
  id, name, game: { id: "g", slug: "g", displayName: "Rust" },
  startsAt: null, endsAt: NOW + 1, status: "untouched", complete: false,
  drops: [{ id: `${id}-d`, name: "Gilded Helmet", benefits: [],
            requiredMinutes: 60, minutes: 0, status: "not-started" }],
  ...extra,
}) as unknown as ResolvedCampaign;

const input = (over: Partial<PaletteInput> = {}): PaletteInput => ({
  query: "", screens, streamers, campaigns: null, minerState: "RUNNING", now: NOW, ...over,
});

const labels = (groups: ReturnType<typeof buildPalette>) => groups.map((g) => g.label);
const ids = (groups: ReturnType<typeof buildPalette>, label: string) =>
  groups.find((g) => g.label === label)?.items.map((i) => i.id) ?? [];

test("with no query: screens, then who is live, then actions", () => {
  const groups = buildPalette(input());
  expect(labels(groups)).toEqual(["Go to", "Live now", "Actions"]);
  expect(ids(groups, "Go to")).toEqual(["screen:dashboard", "screen:streamers", "screen:logs"]);
  // Offline channels are left out until asked for; the busiest comes first.
  expect(ids(groups, "Live now")).toEqual(["streamer:betamax", "streamer:alpha"]);
});

test("with a query: streamers, campaigns, actions, then screens", () => {
  // "a" is in every login, in "Autumn", in "Restart miner" and in "Dashboard".
  const groups = buildPalette(input({ query: "a", campaigns: [campaign("c1", "Autumn")] }));
  expect(labels(groups)).toEqual(["Streamers", "Campaigns", "Actions", "Go to"]);
});

test("groups with no match are left out", () => {
  // "winter" matches only the campaign, and is a valid login to add.
  const groups = buildPalette(input({ query: "winter", campaigns: [campaign("c1", "Winter")] }));
  expect(labels(groups)).toEqual(["Campaigns", "Actions"]);
});

test("a query finds offline streamers too, live ones first", () => {
  const groups = buildPalette(input({ query: "beta" }));
  expect(ids(groups, "Streamers")).toEqual(["streamer:betamax", "streamer:beta"]);
});

test("streamers match on display name as well as login", () => {
  const groups = buildPalette(input({
    query: "max", streamers: [{ username: "bm", displayName: "BetaMax", isOnline: false, viewers: null }],
  }));
  expect(ids(groups, "Streamers")).toEqual(["streamer:bm"]);
});

test("a live streamer is marked live and says how many are watching", () => {
  const [item] = buildPalette(input({ query: "betamax" }))[0].items;
  expect(item.live).toBe(true);
  expect(item.description).toBe("Live · 5.0K viewers");
});

test("search groups stop at the limit", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    username: `chan${i}`, displayName: null, isOnline: false, viewers: null,
  }));
  const groups = buildPalette(input({ query: "chan", streamers: many }));
  expect(ids(groups, "Streamers")).toHaveLength(GROUP_LIMIT);
});

test("campaigns match by name, game or drop; ended ones sink", () => {
  const campaigns = [
    campaign("old", "Autumn", { endsAt: NOW - 1 }),
    campaign("new", "Winter"),
  ];
  expect(ids(buildPalette(input({ query: "winter", campaigns })), "Campaigns")).toEqual(["campaign:new"]);
  expect(ids(buildPalette(input({ query: "rust", campaigns })), "Campaigns"))
    .toEqual(["campaign:new", "campaign:old"]);
  expect(ids(buildPalette(input({ query: "helmet", campaigns })), "Campaigns"))
    .toEqual(["campaign:new", "campaign:old"]);
  const ended = buildPalette(input({ query: "autumn", campaigns }))
    .find((g) => g.label === "Campaigns")!.items[0];
  expect(ended.description).toBe("Rust · ended");
});

test("campaigns not loaded yet give no group rather than an empty one", () => {
  expect(labels(buildPalette(input({ query: "winter" })))).not.toContain("Campaigns");
});

test("the miner offers only what its state allows", () => {
  expect(ids(buildPalette(input({ minerState: "RUNNING" })), "Actions"))
    .toEqual(["miner:stop", "miner:restart"]);
  expect(ids(buildPalette(input({ minerState: "STOPPED" })), "Actions")).toEqual(["miner:start"]);
  expect(labels(buildPalette(input({ minerState: "STARTING" })))).not.toContain("Actions");
  // Unknown is not stopped: offering Start there could start a second miner.
  expect(labels(buildPalette(input({ minerState: null })))).not.toContain("Actions");
});

test("miner actions are searchable by their label", () => {
  const actions = ids(buildPalette(input({ query: "restart" })), "Actions");
  // Miner actions come before the add offer: "restart" is also a valid login.
  expect(actions).toEqual(["miner:restart", "add:restart"]);
});

test("an untracked username can be added", () => {
  expect(ids(buildPalette(input({ query: "newbie" })), "Actions")).toEqual(["add:newbie"]);
  expect(ids(buildPalette(input({ query: "https://twitch.tv/newbie" })), "Actions"))
    .toEqual(["add:newbie"]);
});

test("no add for a tracked channel, whatever its case, or for a non-username", () => {
  expect(ids(buildPalette(input({ query: "ALPHA" })), "Actions")).toEqual([]);
  expect(ids(buildPalette(input({ query: "two words" })), "Actions")).toEqual([]);
});
