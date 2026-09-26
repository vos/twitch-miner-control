import { expect, test } from "vitest";
import type { AppConfig, FollowedGame, Subscription } from "../config/schema.js";
import type { Campaign, Catalogue } from "../state/campaignCatalogue.js";
import type { InventorySnapshot } from "../state/inventory.js";
import { followGames, recordSkipped } from "./follow.js";

const NOW = 10_000;
const watchable = { id: "d1", name: "Crate", benefits: [], requiredMinutes: 60, requiredSubs: 0 };

const campaign = (id: string, over: Partial<Campaign> = {}): Campaign => ({
  id, name: `Campaign ${id}`,
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1, endsAt: NOW + 86_400_000, drops: [{ ...watchable, id: `${id}-d1` }],
  ...over,
});

const game = (over: Partial<FollowedGame> = {}): FollowedGame => ({
  id: "g1", name: "A Game", slug: "a-game", boxArtUrl: null,
  poolSize: 2, skipped: [], ...over,
});

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: "s1", targetId: "c1", label: "Campaign c1", poolSize: 3, rank: 0, ...over,
});

const catalogue = (campaigns: Campaign[], over: Partial<Catalogue> = {}) => ({
  campaigns, available: true, stale: false, ...over,
});

const config = (over: Partial<Pick<AppConfig, "subscriptions" | "followedGames">> = {}) => ({
  subscriptions: [], followedGames: [game()], ...over,
});

let n = 0;
const ids = () => `new-${++n}`;
const run = (
  cfg = config(), cat = catalogue([campaign("c1")]),
  inv: InventorySnapshot | null = null,
) => { n = 0; return followGames(cfg, cat, inv, NOW, ids); };

test("a followed game's campaign becomes a subscription tagged with the game", () => {
  const out = run();
  expect(out.changed).toBe(true);
  expect(out.added.map((a) => a.subscription)).toEqual([{
    id: "new-1", targetId: "c1", label: "Campaign c1",
    poolSize: 2, rank: 0, viaGame: "g1",
  }]);
});

test("campaigns for other games are left alone", () => {
  const out = run(config(), catalogue([campaign("c1", {
    game: { id: "g9", slug: "other", displayName: "Other" },
  }), campaign("c2", { game: null })]));
  expect(out.added).toEqual([]);
  expect(out.changed).toBe(false);
});

test("a campaign already subscribed is not added again", () => {
  expect(run(config({ subscriptions: [sub()] })).added).toEqual([]);
});

test("a skipped campaign is not added", () => {
  expect(run(config({ followedGames: [game({ skipped: ["c1"] })] })).added).toEqual([]);
});

test("an ended campaign is not added", () => {
  expect(run(config(), catalogue([campaign("c1", { endsAt: NOW })])).added).toEqual([]);
});

test("a campaign not open yet is added, to wait like any other", () => {
  const out = run(config(), catalogue([campaign("c1", { startsAt: NOW + 3_600_000 })]));
  expect(out.added).toHaveLength(1);
});

test("a campaign already complete is not added", () => {
  const inv = {
    progress: { c1: { "c1-d1": { minutes: 60, claimed: true, instanceId: null } } },
    earned: {}, fetchedAt: 1, available: true,
  } as never as InventorySnapshot;
  const out = run(config(), catalogue([campaign("c1")]), inv);
  expect(out.added).toEqual([]);
  // Skipped, so a later pass that cannot read progress does not add it back.
  expect(out.followedGames[0]?.skipped).toEqual(["c1"]);
  expect(out.changed).toBe(true);
});

test("unread progress records nothing as complete", () => {
  const out = run(config(), catalogue([campaign("c1")]), null);
  expect(out.followedGames[0]?.skipped).toEqual([]);
});

test("a campaign with no drop watching can earn is not added", () => {
  const gated = campaign("c1", { drops: [{ ...watchable, requiredMinutes: 0 }] });
  expect(run(config(), catalogue([gated])).added).toEqual([]);
});

test("an unavailable catalogue adds nothing", () => {
  expect(run(config(), catalogue([campaign("c1")], { available: false })).added).toEqual([]);
});

test("a stale catalogue still adds", () => {
  expect(run(config(), catalogue([campaign("c1")], { stale: true })).added).toHaveLength(1);
});

test("several new campaigns take the ranks after the highest, in catalogue order", () => {
  // Ranks can have gaps after removals; a new one must never reuse one.
  const out = run(
    config({ subscriptions: [sub({ id: "a", targetId: "x", rank: 0 }),
                             sub({ id: "b", targetId: "y", rank: 5 })] }),
    catalogue([campaign("c1"), campaign("c2")]),
  );
  expect(out.added.map((a) => [a.subscription.targetId, a.subscription.rank]))
    .toEqual([["c1", 6], ["c2", 7]]);
});

test("skipped entries whose campaign left a fresh catalogue are pruned", () => {
  const out = run(
    config({ followedGames: [game({ skipped: ["c1", "gone"] })] }),
    catalogue([campaign("c1")]),
  );
  expect(out.followedGames[0]?.skipped).toEqual(["c1"]);
  expect(out.changed).toBe(true);
});

test("a stale catalogue prunes nothing", () => {
  const out = run(
    config({ followedGames: [game({ skipped: ["gone"] })] }),
    catalogue([], { stale: true }),
  );
  expect(out.followedGames[0]?.skipped).toEqual(["gone"]);
  expect(out.changed).toBe(false);
});

test("recordSkipped files a leaving subscription under the game that added it", () => {
  const out = recordSkipped([game()], [sub({ targetId: "c7", viaGame: "g1" })]);
  expect(out[0]?.skipped).toEqual(["c7"]);
});

test("recordSkipped files a hand-added one under its campaign's followed game", () => {
  const out = recordSkipped([game()], [sub({ targetId: "c7" })], () => "g1");
  expect(out[0]?.skipped).toEqual(["c7"]);
});

test("recordSkipped leaves games untouched when nothing concerns them", () => {
  const games = [game()];
  expect(recordSkipped(games, [sub({ targetId: "c7" })])[0]).toBe(games[0]);
});
