import { expect, test, vi } from "vitest";
import {
  InventoryCache,
  INVENTORY_TTL_MS,
  INVENTORY_REFRESH_MIN_INTERVAL_MS,
  LINK_PROBE_MAX,
  linkProbeChannels,
} from "./inventory.js";

let clock = 1_000_000;

function make(
  responses: unknown[],
  probeChannels?: () => string[],
  onClaims?: (claims: unknown[]) => void,
) {
  clock = 1_000_000;
  const queue = [...responses];
  const request = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { inventory: {} };
  });
  const cache = new InventoryCache({
    client: { request } as never,
    probeChannels,
    onClaims,
    now: () => clock,
  });
  return { cache, request };
}

const progress = { minutes: 30, claimed: false, instanceId: null };

test("reports progress keyed by campaign and drop", async () => {
  const { cache } = make([{ inventory: { c1: { d1: progress } } }]);
  const out = await cache.get();
  expect(out.progress["c1"]?.["d1"]).toEqual(progress);
  expect(out.available).toBe(true);
});

test("serves the cached copy within the TTL", async () => {
  const { cache, request } = make([{ inventory: { c1: { d1: progress } } }]);
  await cache.get();
  clock += INVENTORY_TTL_MS - 1;
  await cache.get();
  expect(request).toHaveBeenCalledTimes(1);
});

test("refetches after the TTL", async () => {
  const { cache, request } = make([
    { inventory: {} },
    { inventory: { c1: { d1: progress } } },
  ]);
  await cache.get();
  clock += INVENTORY_TTL_MS + 1;
  const out = await cache.get();
  expect(out.progress["c1"]?.["d1"]).toEqual(progress);
  expect(request).toHaveBeenCalledTimes(2);
});

test("a failed first fetch reports unavailable rather than empty progress", async () => {
  // The distinction the whole feature turns on: absent-from-inventory
  // means "never started", but a FAILED fetch means "unknown". Reading
  // the second as the first would fill the page with confident zeros.
  const { cache } = make([new Error("gql exploded")]);
  const out = await cache.get();
  expect(out.available).toBe(false);
  expect(out.progress).toEqual({});
});

test("a failure after a good fetch keeps the last progress, marked unavailable", async () => {
  const { cache } = make([
    { inventory: { c1: { d1: progress } } },
    new Error("gql exploded"),
  ]);
  await cache.get();
  clock += INVENTORY_TTL_MS + 1;
  const out = await cache.get();
  expect(out.progress["c1"]?.["d1"]).toEqual(progress);
  expect(out.available).toBe(false);
});

test("a later success clears the unavailable flag", async () => {
  const { cache } = make([
    new Error("gql exploded"),
    { inventory: { c1: { d1: progress } } },
  ]);
  await cache.get();
  clock += INVENTORY_TTL_MS + 1;
  const out = await cache.get();
  expect(out.available).toBe(true);
});

test("an empty inventory is available, not unknown", async () => {
  // Nothing started is a real answer, and a different one from
  // "we could not find out".
  const { cache } = make([{ inventory: {} }]);
  const out = await cache.get();
  expect(out.available).toBe(true);
  expect(out.progress).toEqual({});
});

test("concurrent gets collapse onto a single request", async () => {
  const { cache, request } = make([{ inventory: { c1: { d1: progress } } }]);
  await Promise.all([cache.get(), cache.get()]);
  expect(request).toHaveBeenCalledTimes(1);
});

test("a failed fetch is retried on the next get, not cached for the TTL", async () => {
  // A failure must not lock the page out of progress for ten minutes.
  const { cache, request } = make([
    new Error("gql exploded"),
    { inventory: { c1: { d1: progress } } },
  ]);
  await cache.get();
  const out = await cache.get();
  expect(request).toHaveBeenCalledTimes(2);
  expect(out.available).toBe(true);
});

test("refresh refetches inside the TTL", async () => {
  // The point of the button: progress the user just earned must be
  // reachable without waiting out a clock built for the idle case.
  const { cache, request } = make([
    { inventory: {} },
    { inventory: { c1: { d1: progress } } },
  ]);
  await cache.get();
  clock += 1_000;
  const out = await cache.refresh();
  expect(out.progress["c1"]?.["d1"]).toEqual(progress);
  expect(request).toHaveBeenCalledTimes(2);
});

test("refresh is rate limited", async () => {
  const { cache, request } = make([
    { inventory: {} },
    { inventory: { c1: { d1: progress } } },
    { inventory: {} },
  ]);
  await cache.refresh();
  clock += INVENTORY_REFRESH_MIN_INTERVAL_MS - 1;
  await cache.refresh();
  expect(request).toHaveBeenCalledTimes(1);
});

test("refresh works again once the rate limit has passed", async () => {
  const { cache, request } = make([
    { inventory: {} },
    { inventory: { c1: { d1: progress } } },
  ]);
  await cache.refresh();
  clock += INVENTORY_REFRESH_MIN_INTERVAL_MS + 1;
  const out = await cache.refresh();
  expect(out.progress["c1"]?.["d1"]).toEqual(progress);
  expect(request).toHaveBeenCalledTimes(2);
});

test("a rate limited refresh still serves what it holds", async () => {
  // Returning empty here would blank a page that has good data.
  const { cache } = make([{ inventory: { c1: { d1: progress } } }]);
  await cache.refresh();
  clock += 1_000;
  const out = await cache.refresh();
  expect(out.progress["c1"]?.["d1"]).toEqual(progress);
  expect(out.available).toBe(true);
});

test("a failed refresh keeps the last progress, marked unavailable", async () => {
  const { cache } = make([
    { inventory: { c1: { d1: progress } } },
    new Error("gql exploded"),
  ]);
  await cache.get();
  clock += INVENTORY_REFRESH_MIN_INTERVAL_MS + 1;
  const out = await cache.refresh();
  expect(out.progress["c1"]?.["d1"]).toEqual(progress);
  expect(out.available).toBe(false);
});

test("carries the claimed rewards through", async () => {
  // The half that still knows about a campaign finished and gone from
  // dropCampaignsInProgress -- see dropState.ts.
  const { cache } = make([
    { inventory: {}, earned: { c1: ["Crate", "Charm"] } },
  ]);
  const out = await cache.get();
  expect(out.earned["c1"]).toEqual(["Crate", "Charm"]);
});

test("rewards Twitch could not answer keep the ones already held", async () => {
  // A timeout must not read as "nothing was ever earned": a finished
  // campaign would look unfinished until Twitch recovered.
  const { cache } = make([
    { inventory: {}, earned: { c1: ["Crate"] } },
    { inventory: { c2: {} }, earned: null },
  ]);
  await cache.get();
  clock += INVENTORY_TTL_MS + 1;
  const out = await cache.get();
  expect(out.earned["c1"]).toEqual(["Crate"]);
  expect(out.progress["c2"]).toEqual({});
});

test("rewards unknown on the very first fetch are simply empty", async () => {
  const { cache } = make([{ inventory: {}, earned: null }]);
  expect((await cache.get()).earned).toEqual({});
});

test("a response with no earned rewards reports an empty map", async () => {
  // A helper predating the field, or one whose earned half degraded.
  const { cache } = make([{ inventory: { c1: { d1: progress } } }]);
  const out = await cache.get();
  expect(out.earned).toEqual({});
});

test("reports account links, empty from a helper that predates them", async () => {
  const link = { linked: false, url: null };
  const { cache } = make([{ inventory: {}, links: { c1: link } }, { inventory: {} }]);
  expect((await cache.get()).links).toEqual({ c1: link });
  clock += INVENTORY_TTL_MS + 1;
  expect((await cache.get()).links).toEqual({});
});

test("asks the probe channels read at fetch time", async () => {
  let channels = ["1"];
  const { cache, request } = make([{ inventory: {} }, { inventory: {} }], () => channels);
  await cache.get();
  channels = ["1", "2"];
  clock += INVENTORY_TTL_MS + 1;
  await cache.get();
  expect(request.mock.calls).toEqual([
    ["inventory", { channelIds: ["1"] }],
    ["inventory", { channelIds: ["1", "2"] }],
  ]);
});

test("probes one channel per subscription, live first, skipping unknown ids", () => {
  const config = {
    streamers: [
      { username: "manual" },
      { username: "Off1", ownedBy: "s1" },
      { username: "on1", ownedBy: "s1" },
      { username: "nobody", ownedBy: "s2" },
      { username: "off2", ownedBy: "s3" },
    ],
  };
  const state = [
    { username: "manual", channelId: "0", isOnline: true },
    { username: "off1", channelId: "1", isOnline: false },
    { username: "on1", channelId: "2", isOnline: true },
    { username: "nobody", channelId: null, isOnline: true },
    { username: "off2", channelId: "4", isOnline: null },
  ];
  expect(linkProbeChannels(config, state)).toEqual(["2", "4"]);
});

test("caps the probe", () => {
  const streamers = Array.from({ length: LINK_PROBE_MAX + 5 }, (_, i) => (
    { username: `c${i}`, ownedBy: `s${i}` }));
  const state = streamers.map((s, i) => ({ username: s.username, channelId: `${i}`, isOnline: true }));
  expect(linkProbeChannels({ streamers }, state)).toHaveLength(LINK_PROBE_MAX);
});

test("hands each fetch's verified claims on", async () => {
  const claims = [{ id: "r1", name: "Crate", campaignId: "c1", earnedAt: 5 }];
  const onClaims = vi.fn();
  const { cache } = make([{ inventory: {}, claims }], undefined, onClaims);
  await cache.get();
  expect(onClaims).toHaveBeenCalledWith(claims);
});

test("a fetch that could not read the claims hands nothing on", async () => {
  // Null means the query failed, and is not news that nothing was claimed.
  const onClaims = vi.fn();
  const { cache } = make([{ inventory: {}, claims: null }], undefined, onClaims);
  await cache.get();
  expect(onClaims).not.toHaveBeenCalled();
});
