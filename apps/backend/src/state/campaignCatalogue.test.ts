import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import {
  CampaignCatalogue,
  CATALOGUE_TTL_MS,
  REFRESH_MIN_INTERVAL_MS,
  type Campaign,
} from "./campaignCatalogue.js";

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  id: "c1",
  name: "Campaign One",
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1_000,
  endsAt: 9_000,
  drops: [],
  ...over,
});

let clock = 1_000_000;

function make(responses: unknown[], path?: string) {
  clock = 1_000_000;
  const file = path ?? join(mkdtempSync(join(tmpdir(), "cat-")), "c.json");
  const queue = [...responses];
  // The source throws on failure rather than returning [] -- an empty
  // list must never be mistaken for "no campaigns are running".
  const request = vi.fn(async (): Promise<Campaign[]> => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return (next ?? []) as Campaign[];
  });
  const cache = new CampaignCatalogue({
    source: request,
    path: file,
    now: () => clock,
  });
  return { cache, request, path: file };
}

test("fetches once and serves the cached list within the TTL", async () => {
  const { cache, request } = make([[campaign()]]);
  const first = await cache.get();
  clock += CATALOGUE_TTL_MS - 1;
  const second = await cache.get();
  expect(first.campaigns).toEqual([campaign()]);
  expect(second.campaigns).toEqual([campaign()]);
  expect(request).toHaveBeenCalledTimes(1);
});

test("refetches once the TTL has elapsed", async () => {
  const { cache, request } = make([
    [campaign()],
    [campaign({ id: "c2" })],
  ]);
  await cache.get();
  clock += CATALOGUE_TTL_MS + 1;
  const after = await cache.get();
  expect(after.campaigns[0]?.id).toBe("c2");
  expect(request).toHaveBeenCalledTimes(2);
});

test("serves the stale cache when a refetch fails, flagged stale", async () => {
  // A campaign list from yesterday is overwhelmingly still correct --
  // emptying the page would be a worse lie than showing its age.
  const { cache } = make([
    [campaign()],
    new Error("gql exploded"),
  ]);
  await cache.get();
  clock += CATALOGUE_TTL_MS + 1;
  const after = await cache.get();
  expect(after.campaigns).toEqual([campaign()]);
  expect(after.stale).toBe(true);
  // The age reported is the age of the data, not of the failed attempt.
  expect(after.fetchedAt).toBe(1_000_000);
});

test("a first fetch that fails reports unavailable, not an empty list", async () => {
  // The whole point of the honesty fix: an empty catalogue we never
  // managed to load must not render as "no drop campaigns are running".
  const { cache } = make([new Error("source exploded")]);
  const out = await cache.get();
  expect(out.campaigns).toEqual([]);
  expect(out.stale).toBe(true);
  expect(out.available).toBe(false);
  expect(out.error).toMatch(/source exploded/);
});

test("a successful fetch is available with no error", async () => {
  const { cache } = make([[campaign()]]);
  const out = await cache.get();
  expect(out.available).toBe(true);
  expect(out.error).toBeNull();
});

test("a genuinely empty list is available, unlike a failure", async () => {
  // No campaigns running is a real answer; failing to ask is not.
  const { cache } = make([[]]);
  const out = await cache.get();
  expect(out.campaigns).toEqual([]);
  expect(out.available).toBe(true);
  expect(out.error).toBeNull();
});

test("data from disk stays available when a later refetch fails", async () => {
  const { cache } = make([[campaign()], new Error("source exploded")]);
  await cache.get();
  clock += CATALOGUE_TTL_MS + 1;
  const out = await cache.get();
  expect(out.available).toBe(true);
  expect(out.stale).toBe(true);
  expect(out.error).toMatch(/source exploded/);
});

test("a later success clears the stale flag", async () => {
  const { cache } = make([
    new Error("gql exploded"),
    [campaign()],
  ]);
  await cache.get();
  clock += CATALOGUE_TTL_MS + 1;
  const out = await cache.get();
  expect(out.stale).toBe(false);
  expect(out.error).toBeNull();
  expect(out.campaigns).toEqual([campaign()]);
});

test("survives a restart by reloading from disk", async () => {
  // Campaign metadata stays true across a restart, unlike progress --
  // which is why this one is persisted and inventory is not.
  const { cache, path } = make([[campaign()]]);
  await cache.get();
  const revived = new CampaignCatalogue({
    source: vi.fn(async () => []),
    path,
    now: () => clock,
  });
  const out = await revived.get();
  expect(out.campaigns).toEqual([campaign()]);
});

test("a reloaded catalogue still expires on its original age", async () => {
  const { cache, path } = make([[campaign()]]);
  await cache.get();
  clock += CATALOGUE_TTL_MS + 1;
  const request = vi.fn(async () => [campaign({ id: "c2" })]);
  const revived = new CampaignCatalogue({
    source: request,
    path,
    now: () => clock,
  });
  const out = await revived.get();
  expect(out.campaigns[0]?.id).toBe("c2");
});

test("refresh bypasses the TTL", async () => {
  const { cache, request } = make([
    [campaign()],
    [campaign({ id: "c2" })],
  ]);
  await cache.get();
  clock += REFRESH_MIN_INTERVAL_MS + 1;
  const out = await cache.refresh();
  expect(out.campaigns[0]?.id).toBe("c2");
  expect(request).toHaveBeenCalledTimes(2);
});

test("refresh is rate limited so a double click costs one sweep", async () => {
  // There can be 100+ campaigns behind one refresh; two in a row would
  // be two full detail sweeps against the account.
  const { cache, request } = make([
    [campaign()],
    [campaign({ id: "c2" })],
  ]);
  await cache.refresh();
  const second = await cache.refresh();
  expect(request).toHaveBeenCalledTimes(1);
  expect(second.campaigns[0]?.id).toBe("c1");
});

test("refresh works again once the interval has passed", async () => {
  const { cache, request } = make([
    [campaign()],
    [campaign({ id: "c2" })],
  ]);
  await cache.refresh();
  clock += REFRESH_MIN_INTERVAL_MS + 1;
  await cache.refresh();
  expect(request).toHaveBeenCalledTimes(2);
});

test("concurrent gets collapse onto a single request", async () => {
  // Two page loads must not each trigger a detail sweep.
  const { cache, request } = make([[campaign()]]);
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(a.campaigns).toEqual(b.campaigns);
});

test("a corrupt cache file is ignored rather than fatal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const path = join(dir, "c.json");
  writeFileSync(path, "{ not json");
  const { cache } = make([[campaign()]], path);
  const out = await cache.get();
  expect(out.campaigns).toEqual([campaign()]);
});
