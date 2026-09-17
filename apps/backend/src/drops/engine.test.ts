import { expect, test, vi } from "vitest";
import { SubscriptionEngine } from "./engine.js";
import type { AppConfig } from "../config/schema.js";
import type { Campaign, Catalogue } from "../state/campaignCatalogue.js";

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: "c1", name: "Alpha",
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1, endsAt: Date.now() + 86_400_000, drops: [], ...over,
});

const sub = (over: object = {}) => ({
  id: "s1", kind: "campaign" as const, targetId: "c1",
  label: "Alpha", poolSize: 2, rank: 0, ...over,
});

const manual = (username: string) =>
  ({ username, enabled: true, settings: {} });
const owned = (username: string, ownedBy: string) =>
  ({ username, enabled: true, settings: {}, ownedBy });

function make(over: {
  config?: Partial<AppConfig>;
  catalogue?: Partial<Catalogue>;
  directory?: () => Promise<Array<{ login: string; channelId: string; viewers: number }>>;
} = {}) {
  const config = {
    version: 1, username: "alex", followers: true, followersOrder: "ASC",
    defaults: {}, miner: {},
    streamers: [manual("alpha")],
    subscriptions: [sub()],
    ...over.config,
  } as unknown as AppConfig;
  const saveConfig = vi.fn();
  const propose = vi.fn();
  const engine = new SubscriptionEngine({
    loadConfig: () => config,
    saveConfig,
    configPath: "/tmp/config.json",
    catalogue: {
      get: async (): Promise<Catalogue> => ({
        campaigns: [campaign()], fetchedAt: 1, stale: false,
        available: true, error: null, ...over.catalogue,
      }),
    } as never,
    directory: over.directory ?? (async () => [
      { login: "beta", channelId: "id-beta", viewers: 500 },
      { login: "gamma", channelId: "id-gamma", viewers: 50 },
    ]),
    pending: { propose } as never,
  });
  return { engine, saveConfig, propose, config };
}

const written = (saveConfig: ReturnType<typeof vi.fn>) =>
  saveConfig.mock.calls[0]?.[1] as AppConfig;

test("a pass writes the resolved pool and proposes a restart", async () => {
  const { engine, saveConfig, propose } = make();
  await engine.pass();
  expect(saveConfig).toHaveBeenCalledTimes(1);
  expect(written(saveConfig).streamers.map((s) => s.username))
    .toEqual(["alpha", "beta", "gamma"]);
  expect(propose).toHaveBeenCalledTimes(1);
});

test("an unchanged pass writes nothing and proposes nothing", async () => {
  const { engine, saveConfig, propose } = make({
    config: { streamers: [manual("alpha"), owned("beta", "s1"),
                          owned("gamma", "s1")] as never },
  });
  await engine.pass();
  expect(saveConfig).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});

test("no subscriptions means no work at all", async () => {
  const { engine, saveConfig, propose } = make({
    config: { subscriptions: [] },
  });
  await engine.pass();
  expect(saveConfig).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});

test("a failing directory keeps the existing pool untouched", async () => {
  // Never empty a pool on a lookup failure: that stops collection with
  // no visible cause.
  const { engine, saveConfig, propose } = make({
    config: { streamers: [manual("alpha"), owned("beta", "s1")] as never },
    directory: async () => { throw new Error("hash rotated"); },
  });
  await engine.pass();
  expect(saveConfig).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});

test("subscriptions resolve in rank order", async () => {
  const { engine, saveConfig } = make({
    config: {
      streamers: [],
      subscriptions: [
        sub({ id: "s2", rank: 1, poolSize: 1 }),
        sub({ id: "s1", rank: 0, poolSize: 1 }),
      ],
    },
  });
  await engine.pass();
  // Rank 0 fills the miner's slots first -- it is what priority_order reads.
  expect(written(saveConfig).streamers[0]?.ownedBy).toBe("s1");
});

test("an ended campaign drops its pool and its subscription", async () => {
  // A campaign missing from a FRESH catalogue has ended.
  const { engine, saveConfig, propose } = make({
    config: {
      streamers: [manual("alpha"), owned("beta", "s1")] as never,
      subscriptions: [sub({ targetId: "gone" })],
    },
  });
  await engine.pass();
  const out = written(saveConfig);
  expect(out.streamers.map((s) => s.username)).toEqual(["alpha"]);
  expect(out.subscriptions).toEqual([]);
  expect(propose).toHaveBeenCalledTimes(1);
});

test("a stale catalogue never ends a campaign", async () => {
  // Missing because we could not look is not missing because it ended;
  // concluding otherwise deletes a live subscription over a network blip.
  const { engine, saveConfig, propose } = make({
    config: {
      streamers: [manual("alpha"), owned("beta", "s1")] as never,
      subscriptions: [sub({ targetId: "gone" })],
    },
    catalogue: { stale: true },
  });
  await engine.pass();
  expect(saveConfig).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});

test("an unavailable catalogue never ends a campaign either", async () => {
  const { engine, saveConfig } = make({
    config: {
      streamers: [manual("alpha"), owned("beta", "s1")] as never,
      subscriptions: [sub({ targetId: "gone" })],
    },
    catalogue: { campaigns: [], available: false, error: "source down" },
  });
  await engine.pass();
  expect(saveConfig).not.toHaveBeenCalled();
});

test("a game subscription outlives the campaign catalogue", async () => {
  // It is not tied to any one campaign, so an empty catalogue is fine.
  const { engine, saveConfig } = make({
    config: {
      streamers: [],
      subscriptions: [sub({ kind: "game", targetId: "g1", label: "A Game" })],
    },
    catalogue: { campaigns: [] },
  });
  await engine.pass();
  expect(written(saveConfig).streamers.map((s) => s.username))
    .toEqual(["beta", "gamma"]);
});

test("one subscription failing does not sink the others", async () => {
  let call = 0;
  const { engine, saveConfig } = make({
    config: {
      streamers: [],
      subscriptions: [
        sub({ id: "s1", rank: 0, poolSize: 1 }),
        sub({ id: "s2", rank: 1, poolSize: 1 }),
      ],
    },
    directory: async () => {
      call += 1;
      if (call === 1) throw new Error("transient");
      return [{ login: "beta", channelId: "id-beta", viewers: 5 }];
    },
  });
  await engine.pass();
  expect(written(saveConfig).streamers.map((s) => s.ownedBy)).toEqual(["s2"]);
});

test("the timer stops cleanly", () => {
  const { engine } = make();
  engine.start();
  engine.stop();
  // A second stop must not throw -- shutdown calls it unconditionally.
  expect(() => engine.stop()).not.toThrow();
});
