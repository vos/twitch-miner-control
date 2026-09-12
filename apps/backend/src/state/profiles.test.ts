import { beforeEach, expect, test, vi } from "vitest";
import { openDb } from "../db/schema.js";
import { Profiles } from "../db/profiles.js";
import { ProfileCache, AVATAR_TTL_MS, STREAM_TTL_MS } from "./profiles.js";

let profiles: Profiles;
let clock: number;
beforeEach(() => {
  profiles = new Profiles(openDb(":memory:"));
  clock = 1_000_000;
});

function make(responses: unknown[]) {
  const queue = [...responses];
  // Params are declared even though the fake ignores them: mock.calls is
  // typed from this signature, and a bare `async ()` makes it an empty
  // tuple that tsc refuses to index in the batch-cap test below.
  const request = vi.fn(async (_op: string, _params?: object) => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const cache = new ProfileCache({
    profiles, client: { request } as never, now: () => clock,
  });
  return { cache, request };
}

/** The avatar-only row these tests assert: no stream info resolved. */
const avatarRow = (avatarUrl: string | null) => ({
  avatarUrl, game: null, title: null, viewers: null,
});

test("fetches a login it has never seen and caches it", async () => {
  const { cache, request } = make([{ profiles: { alpha: avatarRow("https://cdn/a.png") } }]);
  expect(await cache.resolve(["alpha"])).toEqual(new Map([["alpha", avatarRow("https://cdn/a.png")]]));
  expect(request).toHaveBeenCalledWith("profiles", { streamers: ["alpha"] });
  expect(profiles.get(["alpha"]).get("alpha")?.avatarUrl).toBe("https://cdn/a.png");
});

test("serves a fresh row without asking the helper", async () => {
  profiles.put("alpha", "https://cdn/a.png", clock);
  const { cache, request } = make([]);
  expect(await cache.resolve(["alpha"])).toEqual(new Map([["alpha", avatarRow("https://cdn/a.png")]]));
  expect(request).not.toHaveBeenCalled();
});

test("a cached null is not re-fetched", async () => {
  // The whole point of storing NULL: a channel with no avatar must not
  // cost a GQL call on every refresh for the rest of time.
  profiles.put("alpha", null, clock);
  const { cache, request } = make([]);
  expect(await cache.resolve(["alpha"])).toEqual(new Map([["alpha", avatarRow(null)]]));
  expect(request).not.toHaveBeenCalled();
});

test("re-fetches a row older than the TTL", async () => {
  profiles.put("alpha", "https://cdn/old.png", clock - AVATAR_TTL_MS - 1);
  const { cache, request } = make([{ profiles: { alpha: avatarRow("https://cdn/new.png") } }]);
  expect(await cache.resolve(["alpha"])).toEqual(new Map([["alpha", avatarRow("https://cdn/new.png")]]));
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
    new Map([["alpha", avatarRow("https://cdn/a.png")], ["beta", avatarRow(null)]]),
  );
});

test("fetches at most MAX_FETCH_PER_PASS logins in one pass", async () => {
  const logins = Array.from({ length: 14 }, (_, i) => `s${i}`);
  const { cache, request } = make([{ profiles: {} }]);
  const found = await cache.resolve(logins);
  expect(request).toHaveBeenCalledOnce();
  expect((request.mock.calls[0][1] as { streamers: string[] }).streamers).toHaveLength(10);
  // Every requested login still gets an entry, fetched or not.
  expect(found.size).toBe(14);
});

test("a login the helper omits is cached as null", async () => {
  const { cache } = make([{ profiles: {} }]);
  expect(await cache.resolve(["alpha"])).toEqual(new Map([["alpha", avatarRow(null)]]));
  expect(profiles.get(["alpha"]).size).toBe(1);
});

test("normalises logins so casing cannot split the cache", async () => {
  profiles.put("alpha", "https://cdn/a.png", clock);
  const { cache, request } = make([]);
  expect(await cache.resolve(["Alpha"])).toEqual(new Map([["alpha", avatarRow("https://cdn/a.png")]]));
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

/** A full row as the helper now reports one. */
const row = (over: Partial<{
  avatarUrl: string | null; game: string | null;
  title: string | null; viewers: number | null;
}> = {}) => ({
  avatarUrl: "https://cdn/a.png", game: "Just Chatting",
  title: "chill stream", viewers: 1247, ...over,
});

test("reports category and viewers for a live channel", async () => {
  const { cache } = make([{ profiles: { alpha: row() } }]);
  const out = await cache.resolve(["alpha"], new Set(["alpha"]));
  expect(out.get("alpha")).toEqual({
    avatarUrl: "https://cdn/a.png", game: "Just Chatting",
    title: "chill stream", viewers: 1247,
  });
});

test("refreshes a live channel's stream info once the stream TTL lapses", async () => {
  const { cache, request } = make([
    { profiles: { alpha: row({ viewers: 1000 }) } },
    { profiles: { alpha: row({ viewers: 2000 }) } },
  ]);
  await cache.resolve(["alpha"], new Set(["alpha"]));
  clock += STREAM_TTL_MS + 1;
  const out = await cache.resolve(["alpha"], new Set(["alpha"]));
  expect(request).toHaveBeenCalledTimes(2);
  expect(out.get("alpha")?.viewers).toBe(2000);
});

test("serves stream info inside the TTL without asking the helper again", async () => {
  const { cache, request } = make([{ profiles: { alpha: row() } }]);
  await cache.resolve(["alpha"], new Set(["alpha"]));
  clock += STREAM_TTL_MS - 1;
  const out = await cache.resolve(["alpha"], new Set(["alpha"]));
  expect(request).toHaveBeenCalledOnce();
  expect(out.get("alpha")?.viewers).toBe(1247);
});

test("does not spend a call refreshing an offline channel's stream info", async () => {
  // The avatar is fresh and an offline channel has nothing moving, so
  // there is nothing worth a GQL call.
  profiles.put("alpha", "https://cdn/a.png", clock);
  const { cache, request } = make([]);
  await cache.resolve(["alpha"], new Set());
  clock += STREAM_TTL_MS * 10;
  await cache.resolve(["alpha"], new Set());
  expect(request).not.toHaveBeenCalled();
});

test("drops a viewer count once the channel goes offline", async () => {
  // The number described a stream that has ended; keeping it would show
  // a live audience on a card that says OFFLINE.
  const { cache } = make([{ profiles: { alpha: row() } }]);
  await cache.resolve(["alpha"], new Set(["alpha"]));
  const out = await cache.resolve(["alpha"], new Set());
  expect(out.get("alpha")?.viewers).toBeNull();
  // The category is a broadcast setting, not a property of the stream,
  // so it survives the stream ending.
  expect(out.get("alpha")?.game).toBe("Just Chatting");
});

test("still refreshes a stale avatar for an offline channel", async () => {
  // The avatar clock is independent of the stream clock: a week-old
  // picture is worth a call whether or not the channel is live.
  profiles.put("alpha", "https://cdn/old.png", clock - AVATAR_TTL_MS - 1);
  const { cache, request } = make([{ profiles: { alpha: row({ viewers: null }) } }]);
  const out = await cache.resolve(["alpha"], new Set());
  expect(request).toHaveBeenCalledOnce();
  expect(out.get("alpha")?.avatarUrl).toBe("https://cdn/a.png");
});

test("does not persist volatile fields across a new cache", async () => {
  // A viewer count reloaded from disk is a number that was true whenever
  // the process last ran, which is worse than having none.
  const first = make([{ profiles: { alpha: row() } }]);
  await first.cache.resolve(["alpha"], new Set(["alpha"]));
  const second = make([]);
  const out = await second.cache.resolve(["alpha"], new Set());
  expect(out.get("alpha")?.avatarUrl).toBe("https://cdn/a.png");
  expect(out.get("alpha")?.viewers).toBeNull();
  expect(out.get("alpha")?.game).toBeNull();
});
