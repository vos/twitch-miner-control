import { expect, test, vi } from "vitest";
import { SubscriptionEngine } from "./engine.js";
import type { AppConfig } from "../config/schema.js";
import type { Campaign, CampaignDrop, Catalogue } from "../state/campaignCatalogue.js";
import type { InventorySnapshot } from "../state/inventory.js";
import { memoryLog } from "../appLog/memory.js";

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
  directory?: (
    game: { name: string; slug: string },
  ) => Promise<Array<{ login: string; channelId: string; viewers: number }>>;
  log?: ReturnType<typeof memoryLog>;
  inventory?: Partial<InventorySnapshot>;
  now?: number | (() => number);
  /** The catalogue read throws, failing the whole pass. */
  catalogueFails?: boolean;
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
      get: async (): Promise<Catalogue> => over.catalogueFails ? Promise.reject(new Error("down")) : ({
        campaigns: [campaign()], fetchedAt: 1, stale: false,
        available: true, error: null, ...over.catalogue,
      }),
    } as never,
    directory: over.directory ?? (async () => [
      { login: "beta", channelId: "id-beta", viewers: 500 },
      { login: "gamma", channelId: "id-gamma", viewers: 50 },
    ]),
    pending: { propose } as never,
    inventory: {
      get: async (): Promise<InventorySnapshot> => ({
        progress: {}, earned: {}, fetchedAt: 1, available: true,
        ...over.inventory,
      }),
    },
    now: typeof over.now === "function"
      ? over.now
      : over.now === undefined ? undefined : () => over.now as number,
    log: over.log,
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

test("swapping two subscriptions' ranks rewrites the order and proposes a restart", async () => {
  // The reorder case end to end: both pools are already resolved and
  // nothing about WHICH channels are watched changes -- only their
  // sequence. That sequence is what upstream's priority_order consumes,
  // so it has to count as a change and earn a restart, or a reorder is
  // a no-op the user cannot see.
  const { engine, saveConfig, propose } = make({
    config: {
      streamers: [owned("beta", "s2"), owned("delta", "s1")] as never,
      subscriptions: [
        sub({ id: "s1", rank: 0, poolSize: 1 }),
        sub({ id: "s2", targetId: "c2", rank: 1, poolSize: 1 }),
      ],
    },
    catalogue: {
      campaigns: [campaign(), campaign({
        id: "c2", name: "Beta",
        game: { id: "g2", slug: "b-game", displayName: "B Game" },
      })],
    },
    directory: async (game: { slug: string }) => [
      game.slug === "a-game"
        ? { login: "delta", channelId: "id-delta", viewers: 100 }
        : { login: "beta", channelId: "id-beta", viewers: 500 },
    ],
  });
  await engine.pass();
  // s1 now outranks s2, so its channel is written first.
  expect(written(saveConfig).streamers.map((s) => s.username))
    .toEqual(["delta", "beta"]);
  expect(propose).toHaveBeenCalledTimes(1);
});

test("a live pool whose viewer ranking shuffled does not restart the miner", async () => {
  // The bug this guards: the pool was rebuilt as an absolute top-N by
  // viewers every pass, so two live members trading places rewrote the
  // config and restarted the miner. All three still collect; nothing
  // about the drop changed.
  const { engine, saveConfig, propose } = make({
    config: {
      streamers: [owned("beta", "s1"), owned("gamma", "s1")] as never,
      subscriptions: [sub({ poolSize: 2 })],
    },
    directory: async () => [
      { login: "gamma", channelId: "id-gamma", viewers: 900 },
      { login: "beta", channelId: "id-beta", viewers: 50 },
    ],
  });
  await engine.pass();
  expect(saveConfig).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});

test("a bigger channel appearing does not evict a live pool member", async () => {
  const { engine, saveConfig, propose } = make({
    config: {
      streamers: [owned("beta", "s1"), owned("gamma", "s1")] as never,
      subscriptions: [sub({ poolSize: 2 })],
    },
    directory: async () => [
      { login: "omega", channelId: "id-omega", viewers: 9000 },
      { login: "beta", channelId: "id-beta", viewers: 500 },
      { login: "gamma", channelId: "id-gamma", viewers: 50 },
    ],
  });
  await engine.pass();
  expect(saveConfig).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});

test("a pool down to its last live member still does not restart", async () => {
  const { engine, saveConfig, propose } = make({
    config: {
      streamers: [owned("beta", "s1"), owned("gamma", "s1")] as never,
      subscriptions: [sub({ poolSize: 2 })],
    },
    directory: async () => [
      { login: "omega", channelId: "id-omega", viewers: 9000 },
      { login: "beta", channelId: "id-beta", viewers: 5 },
    ],
  });
  await engine.pass();
  expect(saveConfig).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});

test("a pool with nobody live left is rebuilt and earns its restart", async () => {
  const { engine, saveConfig, propose } = make({
    config: {
      streamers: [owned("beta", "s1"), owned("gamma", "s1")] as never,
      subscriptions: [sub({ poolSize: 2 })],
    },
    directory: async () => [
      { login: "omega", channelId: "id-omega", viewers: 9000 },
      { login: "delta", channelId: "id-delta", viewers: 500 },
    ],
  });
  await engine.pass();
  expect(written(saveConfig).streamers.map((s) => s.username))
    .toEqual(["omega", "delta"]);
  expect(propose).toHaveBeenCalledTimes(1);
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
  const after = written(saveConfig).streamers;
  expect(after.some((s) => s.username === "delta")).toBe(false);
  expect(new Set(after.map((s) => s.ownedBy))).toEqual(new Set(["s1"]));
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

test("the boot pass writes the config but proposes no restart", async () => {
  // It runs before the miner starts, and the miner reads what it wrote.
  const log = memoryLog();
  const { engine, saveConfig, propose } = make({ log });
  await engine.boot();
  expect(saveConfig).toHaveBeenCalledTimes(1);
  expect(propose).not.toHaveBeenCalled();
  expect(log.ofType("subscription.pass.start")[0]).toMatchObject({ trigger: "boot" });
});

test("a boot pass past its budget stops holding the miner and proposes a restart", async () => {
  // The miner started on the old channels, so this change needs one.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { engine, saveConfig, propose } = make({
    directory: async () => {
      await gate;
      return [{ login: "beta", channelId: "id-beta", viewers: 5 }];
    },
  });
  await engine.boot(10);
  expect(saveConfig).not.toHaveBeenCalled();
  release();
  await vi.waitFor(() => expect(propose).toHaveBeenCalledTimes(1));
});

test("a failing boot pass still lets the miner start, and says why", async () => {
  const log = memoryLog();
  const { engine } = make({ log, catalogueFails: true });
  await expect(engine.boot()).resolves.toBeUndefined();
  expect(log.ofType("subscription.pass.failed")[0]).toMatchObject({ err: "down" });
});

test("a later timer pass proposes as usual", async () => {
  // Only the boot pass is spared the restart.
  const { engine, propose } = make();
  await engine.pass("timer");
  expect(propose).toHaveBeenCalledTimes(1);
});

test("the timer stops cleanly", () => {
  const { engine } = make();
  engine.start();
  engine.stop();
  // A second stop must not throw -- shutdown calls it unconditionally.
  expect(() => engine.stop()).not.toThrow();
});

test("records WHY a pool was kept, with the evidence", async () => {
  // The event that would have made the pool re-resolve bug visible on
  // sight: still collecting, so nothing was touched, and here is how
  // many were live when we decided that.
  const log = memoryLog();
  const { engine } = make({
    log,
    config: {
      streamers: [owned("beta", "s1"), owned("gamma", "s1")] as never,
      subscriptions: [sub({ poolSize: 2 })],
    },
    directory: async () => [
      { login: "omega", channelId: "id-omega", viewers: 9000 },
      { login: "beta", channelId: "id-beta", viewers: 5 },
    ],
  });
  await engine.pass();
  const event = log.ofType("subscription.pool.kept")[0];
  expect(event).toMatchObject({
    liveCount: 1,
    incumbents: ["beta", "gamma"],
    component: "drops",
    level: "info",
  });
  // It kept the pool, so nothing was reconciled and no restart proposed.
  expect(log.ofType("subscription.reconciled")).toEqual([]);
});

test("records a rebuild with what it went from and to", async () => {
  const log = memoryLog();
  const { engine } = make({
    log,
    config: {
      streamers: [owned("beta", "s1")] as never,
      subscriptions: [sub({ poolSize: 2 })],
    },
    directory: async () => [
      { login: "omega", channelId: "id-omega", viewers: 9000 },
      { login: "delta", channelId: "id-delta", viewers: 500 },
    ],
  });
  await engine.pass();
  expect(log.ofType("subscription.pool.rebuilt")[0]).toMatchObject({
    from: ["beta"],
    to: ["omega", "delta"],
    directorySize: 2,
  });
});

test("records what the watch list gained and lost", async () => {
  const log = memoryLog();
  const { engine } = make({
    log,
    config: {
      streamers: [owned("beta", "s1")] as never,
      subscriptions: [sub({ poolSize: 1 })],
    },
    directory: async () => [{ login: "omega", channelId: "id-o", viewers: 9 }],
  });
  await engine.pass();
  expect(log.ofType("subscription.reconciled")[0]).toMatchObject({
    added: ["omega"],
    removed: ["beta"],
  });
});

test("records the trigger, so a pass explains why it ran", async () => {
  const log = memoryLog();
  const { engine } = make({ log });
  await engine.pass("subscribe");
  expect(log.ofType("subscription.pass.start")[0]).toMatchObject({
    trigger: "subscribe",
    subscriptions: 1,
  });
});

test("a pass that changes nothing stays at debug", async () => {
  // The common case by design: a healthy quarter-hour must not fill the
  // log with lines saying nothing happened.
  const log = memoryLog();
  const { engine } = make({
    log,
    config: {
      streamers: [manual("alpha"), owned("beta", "s1"),
                  owned("gamma", "s1")] as never,
    },
  });
  await engine.pass();
  expect(log.ofType("subscription.pass.noop")[0]?.level).toBe("debug");
  // Nothing was reconciled and no restart proposed, so the pass produced
  // no record of a CHANGE -- only the (info) note that the pool still
  // holds, which is the one line a quiet quarter-hour is worth.
  expect(log.ofType("subscription.reconciled")).toEqual([]);
  expect(log.events.filter((e) => e.level === "warn" || e.level === "error"))
    .toEqual([]);
});

test("records a directory failure and the pool it preserved", async () => {
  // Currently a silent catch: the pool survives, but nothing says the
  // lookup failed or that the channels are stale as a result.
  const log = memoryLog();
  const { engine } = make({
    log,
    config: { streamers: [owned("beta", "s1")] as never },
    directory: async () => { throw new Error("hash rotated"); },
  });
  await engine.pass();
  expect(log.ofType("subscription.directory.failed")[0]).toMatchObject({
    err: "hash rotated",
  });
  expect(log.ofType("subscription.degraded")[0]).toMatchObject({
    reason: "directory-failed",
    kept: 1,
  });
});

test("records a campaign that ended", async () => {
  const log = memoryLog();
  const { engine } = make({
    log,
    config: {
      streamers: [owned("beta", "s1")] as never,
      subscriptions: [sub({ targetId: "gone" })],
    },
  });
  await engine.pass();
  expect(log.ofType("subscription.ended")[0]).toMatchObject({
    targetId: "gone",
    level: "warn",
  });
});

const drop = (over: Partial<CampaignDrop> = {}): CampaignDrop => ({
  id: "d1", name: "Hat", benefits: [{ name: "Hat", imageUrl: null }],
  requiredMinutes: 60, requiredSubs: 0, ...over,
});
const entry = (over: object = {}) =>
  ({ minutes: 60, claimed: true, instanceId: null, ...over });

test("a campaign past its end date is removed even while still listed", async () => {
  const log = memoryLog();
  const { engine, saveConfig, propose } = make({
    log,
    now: 5_000,
    catalogue: { campaigns: [campaign({ endsAt: 4_000 })] },
    config: { streamers: [manual("alpha"), owned("beta", "s1")] as never },
  });
  await engine.pass();
  expect(written(saveConfig).subscriptions).toEqual([]);
  expect(written(saveConfig).streamers.map((s) => s.username)).toEqual(["alpha"]);
  expect(propose).toHaveBeenCalledTimes(1);
  expect(log.ofType("subscription.ended")[0]).toMatchObject({
    reason: "expired", label: "Alpha", endsAt: 4_000, level: "info",
  });
});

test("an end date is trusted from a stale catalogue", async () => {
  const { engine, saveConfig } = make({
    now: 5_000,
    catalogue: { campaigns: [campaign({ endsAt: 4_000 })], stale: true },
  });
  await engine.pass();
  expect(written(saveConfig).subscriptions).toEqual([]);
});

test("a campaign with every drop claimed or claimable is removed as complete", async () => {
  const log = memoryLog();
  const { engine, saveConfig } = make({
    log,
    catalogue: { campaigns: [campaign({
      drops: [drop(), drop({ id: "d2", name: "Cape" })],
    })] },
    inventory: { progress: { c1: {
      d1: entry(),
      d2: entry({ claimed: false, instanceId: "i2" }),
    } } },
    config: { streamers: [owned("beta", "s1")] as never },
  });
  await engine.pass();
  expect(written(saveConfig).subscriptions).toEqual([]);
  expect(written(saveConfig).streamers).toEqual([]);
  expect(log.ofType("subscription.completed")[0]).toMatchObject({
    subscriptionId: "s1", label: "Alpha", level: "info",
  });
});

test("a finished campaign known only from earned rewards is complete", async () => {
  // A fully-claimed campaign leaves the progress map; the reward names
  // are all that still say it was finished.
  const { engine, saveConfig } = make({
    catalogue: { campaigns: [campaign({ drops: [drop()] })] },
    inventory: { earned: { c1: ["Hat"] } },
  });
  await engine.pass();
  expect(written(saveConfig).subscriptions).toEqual([]);
});

test("unobtainable drops do not hold a campaign open", async () => {
  const { engine, saveConfig } = make({
    catalogue: { campaigns: [campaign({
      drops: [drop(), drop({ id: "gift", requiredMinutes: 0 })],
    })] },
    inventory: { progress: { c1: { d1: entry() } } },
  });
  await engine.pass();
  expect(written(saveConfig).subscriptions).toEqual([]);
});

test.each([
  ["partly watched", { progress: { c1: { d1: entry({ minutes: 30, claimed: false }) } } }],
  ["unavailable progress", { available: false, earned: { c1: ["Hat"] } }],
])("a campaign with %s keeps its subscription", async (_name, inventory) => {
  const { engine, saveConfig } = make({
    catalogue: { campaigns: [campaign({ drops: [drop()] })] },
    inventory,
  });
  await engine.pass();
  expect(written(saveConfig).subscriptions.map((s) => s.id)).toEqual(["s1"]);
});

test("a campaign of only unobtainable drops is never complete", async () => {
  const { engine, saveConfig } = make({
    catalogue: { campaigns: [campaign({ drops: [drop({ requiredMinutes: 0 })] })] },
  });
  await engine.pass();
  expect(written(saveConfig).subscriptions.map((s) => s.id)).toEqual(["s1"]);
});

test("a game subscription is never ended by one campaign", async () => {
  const { engine, saveConfig } = make({
    now: 5_000,
    catalogue: { campaigns: [campaign({ endsAt: 4_000 })] },
    config: { subscriptions: [sub({ kind: "game", targetId: "g1" })] },
  });
  await engine.pass();
  expect(written(saveConfig).subscriptions.map((s) => s.id)).toEqual(["s1"]);
});

// --- campaigns not open yet ---

const HOUR = 3_600_000;

test("subscribing to a campaign not open yet adds no channels and proposes no restart", async () => {
  const log = memoryLog();
  const { engine, saveConfig, propose } = make({
    log,
    now: 1_000,
    catalogue: { campaigns: [campaign({ startsAt: 1_000 + HOUR })] },
    config: { streamers: [manual("alpha")] as never },
  });
  await engine.pass("subscribe");
  expect(saveConfig).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
  expect(log.ofType("subscription.scheduled")[0]).toMatchObject({
    subscriptionId: "s1", opensAt: 1_000 + HOUR, level: "info",
  });
});

test("a scheduled campaign is logged once, not on every pass", async () => {
  const log = memoryLog();
  const { engine } = make({
    log,
    now: 1_000,
    catalogue: { campaigns: [campaign({ startsAt: 1_000 + HOUR })] },
  });
  await engine.pass();
  await engine.pass();
  expect(log.ofType("subscription.scheduled")).toHaveLength(1);
});

test("channels a scheduled campaign already held are released", async () => {
  const { engine, saveConfig } = make({
    now: 1_000,
    catalogue: { campaigns: [campaign({ startsAt: 1_000 + HOUR })] },
    config: { streamers: [manual("alpha"), owned("beta", "s1")] as never },
  });
  await engine.pass();
  expect(written(saveConfig).streamers.map((s) => s.username)).toEqual(["alpha"]);
});

test("a scheduled campaign resolves its channels once it opens", async () => {
  const log = memoryLog();
  let now = 1_000;
  const { engine, saveConfig, propose } = make({
    log,
    now: () => now,
    catalogue: { campaigns: [campaign({ startsAt: 1_000 + HOUR })] },
  });
  await engine.pass();
  expect(saveConfig).not.toHaveBeenCalled();
  now += HOUR + 1;
  await engine.pass();
  expect(written(saveConfig).streamers.map((s) => s.ownedBy)).toContain("s1");
  expect(propose).toHaveBeenCalledTimes(1);
  expect(log.ofType("subscription.opened")[0]).toMatchObject({ subscriptionId: "s1" });
});

// --- the one-at-a-time queue ---

const queued = (over: object = {}) => make({
  // Per game: one channel can only belong to one subscription.
  directory: async (game) => [
    { login: `${game.slug}-1`, channelId: `${game.slug}-1`, viewers: 500 },
    { login: `${game.slug}-2`, channelId: `${game.slug}-2`, viewers: 50 },
  ],
  catalogue: { campaigns: [
    campaign(),
    campaign({ id: "c2", name: "Beta", game: { id: "g2", slug: "b-game", displayName: "B Game" } }),
  ] },
  ...over,
});
const twoSubs = [
  sub(),
  sub({ id: "s2", targetId: "c2", label: "Beta", rank: 1 }),
];

test("with the queue on, only the first campaign subscription gets channels", async () => {
  const log = memoryLog();
  const { engine, saveConfig } = queued({
    log,
    config: { streamers: [], subscriptions: twoSubs, campaignQueue: true },
  });
  await engine.pass();
  expect(written(saveConfig).streamers.map((s) => s.ownedBy))
    .toEqual(["s1", "s1"]);
  expect(log.ofType("subscription.queue.started")[0]).toMatchObject({
    subscriptionId: "s1", waiting: 1, level: "info",
  });
});

test("with the queue off, every campaign subscription gets channels", async () => {
  const { engine, saveConfig } = queued({
    config: { streamers: [], subscriptions: twoSubs },
  });
  await engine.pass();
  expect(new Set(written(saveConfig).streamers.map((s) => s.ownedBy)))
    .toEqual(new Set(["s1", "s2"]));
});

test("a waiting subscription's channels are released", async () => {
  // It held them before the queue was turned on, or before a reorder
  // put another campaign first.
  const { engine, saveConfig } = queued({
    config: {
      streamers: [owned("beta", "s1"), owned("gamma", "s1"), owned("delta", "s2")] as never,
      subscriptions: twoSubs, campaignQueue: true,
    },
  });
  await engine.pass();
  const after = written(saveConfig).streamers;
  expect(after.some((s) => s.username === "delta")).toBe(false);
  expect(new Set(after.map((s) => s.ownedBy))).toEqual(new Set(["s1"]));
});

test("when the active campaign completes, the next starts on the same pass", async () => {
  const log = memoryLog();
  const { engine, saveConfig } = make({
    log,
    catalogue: { campaigns: [
      campaign({ drops: [drop()] }),
      campaign({ id: "c2", name: "Beta" }),
    ] },
    inventory: { progress: { c1: { d1: entry() } } },
    config: {
      streamers: [owned("beta", "s1"), owned("gamma", "s1")] as never,
      subscriptions: twoSubs, campaignQueue: true,
    },
  });
  await engine.pass();
  expect(written(saveConfig).subscriptions.map((s) => s.id)).toEqual(["s2"]);
  expect(written(saveConfig).streamers.map((s) => s.ownedBy)).toEqual(["s2", "s2"]);
  expect(log.ofType("subscription.completed")).toHaveLength(1);
  expect(log.ofType("subscription.queue.started")[0]).toMatchObject({
    subscriptionId: "s2", waiting: 0,
  });
});

test("the queue start is logged once, not on every pass", async () => {
  const log = memoryLog();
  const { engine } = queued({
    log,
    config: { streamers: [], subscriptions: twoSubs, campaignQueue: true },
  });
  await engine.pass();
  await engine.pass();
  expect(log.ofType("subscription.queue.started")).toHaveLength(1);
});

test("game subscriptions keep their channels with the queue on", async () => {
  const { engine, saveConfig } = queued({
    config: {
      streamers: [],
      subscriptions: [...twoSubs, sub({ id: "g", kind: "game", targetId: "g1", rank: 2 })],
      campaignQueue: true,
    },
  });
  await engine.pass();
  expect(new Set(written(saveConfig).streamers.map((s) => s.ownedBy)))
    .toEqual(new Set(["s1", "g"]));
});

test("an engine with no logger behaves identically", async () => {
  const { engine, saveConfig } = make();
  await expect(engine.pass()).resolves.toBeUndefined();
  expect(saveConfig).toHaveBeenCalledTimes(1);
});
