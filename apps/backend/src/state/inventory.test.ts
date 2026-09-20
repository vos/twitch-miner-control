import { expect, test, vi } from "vitest";
import {
  InventoryCache,
  INVENTORY_TTL_MS,
  INVENTORY_REFRESH_MIN_INTERVAL_MS,
} from "./inventory.js";

let clock = 1_000_000;

function make(responses: unknown[]) {
  clock = 1_000_000;
  const queue = [...responses];
  const request = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { inventory: {} };
  });
  const cache = new InventoryCache({
    client: { request } as never,
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

test("a response with no earned rewards reports an empty map", async () => {
  // A helper predating the field, or one whose earned half degraded.
  const { cache } = make([{ inventory: { c1: { d1: progress } } }]);
  const out = await cache.get();
  expect(out.earned).toEqual({});
});
