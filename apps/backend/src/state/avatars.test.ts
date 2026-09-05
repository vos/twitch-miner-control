import { beforeEach, expect, test, vi } from "vitest";
import { openDb } from "../db/schema.js";
import { Profiles } from "../db/profiles.js";
import { AvatarCache, AVATAR_TTL_MS } from "./avatars.js";

let profiles: Profiles;
let clock: number;
beforeEach(() => {
  profiles = new Profiles(openDb(":memory:"));
  clock = 1_000_000;
});

function make(responses: unknown[]) {
  const queue = [...responses];
  const request = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const cache = new AvatarCache({
    profiles, client: { request } as never, now: () => clock,
  });
  return { cache, request };
}

test("fetches a login it has never seen and caches it", async () => {
  const { cache, request } = make([{ avatars: { alpha: "https://cdn/a.png" } }]);
  expect(await cache.resolve(["alpha"])).toEqual(new Map([["alpha", "https://cdn/a.png"]]));
  expect(request).toHaveBeenCalledWith("avatars", { streamers: ["alpha"] });
  expect(profiles.get(["alpha"]).get("alpha")?.avatarUrl).toBe("https://cdn/a.png");
});

test("serves a fresh row without asking the helper", async () => {
  profiles.put("alpha", "https://cdn/a.png", clock);
  const { cache, request } = make([]);
  expect(await cache.resolve(["alpha"])).toEqual(new Map([["alpha", "https://cdn/a.png"]]));
  expect(request).not.toHaveBeenCalled();
});

test("a cached null is not re-fetched", async () => {
  // The whole point of storing NULL: a channel with no avatar must not
  // cost a GQL call on every refresh for the rest of time.
  profiles.put("alpha", null, clock);
  const { cache, request } = make([]);
  expect(await cache.resolve(["alpha"])).toEqual(new Map([["alpha", null]]));
  expect(request).not.toHaveBeenCalled();
});

test("re-fetches a row older than the TTL", async () => {
  profiles.put("alpha", "https://cdn/old.png", clock - AVATAR_TTL_MS - 1);
  const { cache, request } = make([{ avatars: { alpha: "https://cdn/new.png" } }]);
  expect(await cache.resolve(["alpha"])).toEqual(new Map([["alpha", "https://cdn/new.png"]]));
  expect(request).toHaveBeenCalledOnce();
  expect(profiles.get(["alpha"]).get("alpha")?.fetchedAt).toBe(clock);
});

test("a row exactly at the TTL boundary is still fresh", async () => {
  profiles.put("alpha", "https://cdn/a.png", clock - AVATAR_TTL_MS);
  const { cache, request } = make([]);
  await cache.resolve(["alpha"]);
  expect(request).not.toHaveBeenCalled();
});

test("a helper failure returns cached entries and does not throw", async () => {
  // An avatar lookup must never fail a refresh -- the balances in the
  // same tick are what the dashboard is actually for.
  profiles.put("alpha", "https://cdn/a.png", clock);
  const { cache } = make([new Error("helper exploded")]);
  expect(await cache.resolve(["alpha", "beta"])).toEqual(
    new Map([["alpha", "https://cdn/a.png"], ["beta", null]]),
  );
});

test("fetches at most MAX_FETCH_PER_PASS logins in one pass", async () => {
  const logins = Array.from({ length: 14 }, (_, i) => `s${i}`);
  const { cache, request } = make([{ avatars: {} }]);
  const found = await cache.resolve(logins);
  expect(request).toHaveBeenCalledOnce();
  expect((request.mock.calls[0][1] as { streamers: string[] }).streamers).toHaveLength(10);
  // Every requested login still gets an entry, fetched or not.
  expect(found.size).toBe(14);
});

test("a login the helper omits is cached as null", async () => {
  const { cache } = make([{ avatars: {} }]);
  expect(await cache.resolve(["alpha"])).toEqual(new Map([["alpha", null]]));
  expect(profiles.get(["alpha"]).size).toBe(1);
});

test("normalises logins so casing cannot split the cache", async () => {
  profiles.put("alpha", "https://cdn/a.png", clock);
  const { cache, request } = make([]);
  expect(await cache.resolve(["Alpha"])).toEqual(new Map([["alpha", "https://cdn/a.png"]]));
  expect(request).not.toHaveBeenCalled();
});

test("makes no request when every login is cached", async () => {
  profiles.put("alpha", "https://cdn/a.png", clock);
  profiles.put("beta", null, clock);
  const { cache, request } = make([]);
  await cache.resolve(["alpha", "beta"]);
  expect(request).not.toHaveBeenCalled();
});

test("resolving nothing makes no request", async () => {
  const { cache, request } = make([]);
  expect((await cache.resolve([])).size).toBe(0);
  expect(request).not.toHaveBeenCalled();
});
