# Streamer Avatars & Twitch Profile Links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each streamer's Twitch profile picture on the dashboard and the Streamers screen, with the avatar and name linking to their Twitch channel.

**Architecture:** The avatar URL is a derived, cached attribute of a streamer. A new `AvatarCache` resolves URLs from a SQLite table, calling a new `avatars` op on the Python helper only for logins that are missing or older than the 7-day TTL, then writes through. `StateService` attaches the resolved `avatarUrl` to each `StreamerState`, so it rides the existing `/api/streamers` response and SSE `state` frame — no new HTTP route and no second frontend fetch. The browser loads image bytes straight from Twitch's CDN; the backend only ever handles the URL string.

**Tech Stack:** TypeScript, better-sqlite3, Fastify, Python 3.12, React 19, Mantine 9, Vitest, @testing-library/react, pytest.

**Spec:** `docs/superpowers/specs/2026-09-05-streamer-avatars-design.md`

## Global Constraints

- **Prototype, no backward compatibility.** Schema, API shape and state types may change freely. `history.db` may be deleted rather than migrated. Do not write migration or compatibility code.
- **Commit straight to `main`.** No feature branches (project convention).
- **An avatar failure is never a state error.** A failed or missing avatar resolves to `null` and renders a monogram. It must never reach `snapshot.error` and must never trip the `auth-error` path that signs the user out — with the single exception of a genuine auth failure inside the Python helper, which propagates as `code: "AUTH"` exactly as `_state` already does.
- **Avatar work must not widen the balance poll.** Resolution runs after the `state` response is in hand.
- **Derived fields must be deterministic, not wall-clock varying.** `StateService.doRefresh` detects change via `JSON.stringify(this.streamers)`. `avatarUrl` is a stable cached string, which satisfies this; never attach a timestamp or an age to `StreamerState`.
- **`MAX_FETCH_PER_PASS = 10`** — at most ten avatar lookups per refresh, so a fifty-channel follow list cannot fire fifty GQL calls in one tick or threaten `NdjsonClient`'s 30s request timeout.
- **`AVATAR_TTL_MS = 7 * 86_400_000`** (7 days).
- **Cache keys are normalised logins**, via `normaliseUsername` from `apps/backend/src/state/roster.ts`.
- **Profile links use the login, never the display name.** Display names may be non-ASCII and do not resolve as URLs.
- Backend tests: `pnpm --filter @app/backend test`. Frontend tests: `pnpm --filter @app/frontend test`. Python tests: `uv run pytest python/tests/`.

---

## File Structure

**Backend**
- `apps/backend/src/db/schema.ts` — add the `streamer_profiles` table to the existing `CREATE TABLE IF NOT EXISTS` block. Owns DDL.
- `apps/backend/src/db/profiles.ts` *(new)* — `Profiles` class, all SQL for `streamer_profiles`. Separate from `history.ts` because that class owns points and events; a profile cache is an unrelated concern with its own tests.
- `apps/backend/src/state/avatars.ts` *(new)* — `AvatarCache`. Partitioning, TTL, batch cap, error swallowing. No SQL of its own (delegates to `Profiles`), no transport of its own (delegates to the injected client).
- `apps/backend/src/state/service.ts` — attach `avatarUrl` to `StreamerState`.
- `apps/backend/src/index.ts` — construct `Profiles` + `AvatarCache`, inject into `StateService`.

**Python**
- `python/helpers/state.py` — new `avatars` op on `Handler`.

**Frontend**
- `apps/frontend/src/components/StreamerAvatar.tsx` *(new)* — presentational avatar + link. Used by both surfaces, so it is a component rather than duplicated JSX.
- `apps/frontend/src/components/StreamerCard.tsx` — avatar in the card header.
- `apps/frontend/src/routes/Streamers.tsx` — avatar in each config row.
- `apps/frontend/src/api/useLiveState.ts` — mirror the new `StreamerState` field.

---

### Task 1: `streamer_profiles` table and the `Profiles` data class

**Files:**
- Modify: `apps/backend/src/db/schema.ts`
- Create: `apps/backend/src/db/profiles.ts`
- Test: `apps/backend/src/db/profiles.test.ts`

**Interfaces:**
- Consumes: `Db` from `./schema.js`.
- Produces:
  - `interface ProfileRow { login: string; avatarUrl: string | null; fetchedAt: number }`
  - `class Profiles`, constructed as `new Profiles(db: Db)`, with:
    - `get(logins: string[]): Map<string, ProfileRow>` — keyed by login, only logins that have a row.
    - `put(login: string, avatarUrl: string | null, ts: number): void` — insert or replace.

Note the deliberate `avatar_url` nullability: a `NULL` value means "asked Twitch, found none" and a *missing row* means "never asked". Task 2's TTL logic depends on that distinction.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/db/profiles.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { openDb } from "./schema.js";
import { Profiles } from "./profiles.js";

let profiles: Profiles;
beforeEach(() => { profiles = new Profiles(openDb(":memory:")); });

test("returns no rows for logins never stored", () => {
  expect(profiles.get(["alpha"]).size).toBe(0);
});

test("stores and reads back a url", () => {
  profiles.put("alpha", "https://cdn/a.png", 1000);
  expect(profiles.get(["alpha"]).get("alpha")).toEqual({
    login: "alpha", avatarUrl: "https://cdn/a.png", fetchedAt: 1000,
  });
});

test("a stored null is a row, not an absence", () => {
  // "we asked and there is no avatar" must be distinguishable from
  // "we never asked", or a channel without an avatar is re-fetched forever.
  profiles.put("alpha", null, 1000);
  const row = profiles.get(["alpha"]).get("alpha");
  expect(row).toEqual({ login: "alpha", avatarUrl: null, fetchedAt: 1000 });
});

test("put replaces an existing row rather than duplicating it", () => {
  profiles.put("alpha", "https://cdn/old.png", 1000);
  profiles.put("alpha", "https://cdn/new.png", 2000);
  const found = profiles.get(["alpha"]);
  expect(found.size).toBe(1);
  expect(found.get("alpha")).toEqual({
    login: "alpha", avatarUrl: "https://cdn/new.png", fetchedAt: 2000,
  });
});

test("get reads many logins at once and omits the unknown ones", () => {
  profiles.put("alpha", "https://cdn/a.png", 1000);
  profiles.put("beta", null, 1000);
  const found = profiles.get(["alpha", "beta", "gamma"]);
  expect([...found.keys()].sort()).toEqual(["alpha", "beta"]);
});

test("get with no logins does not query", () => {
  profiles.put("alpha", "https://cdn/a.png", 1000);
  expect(profiles.get([]).size).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test -- profiles`
Expected: FAIL — cannot resolve `./profiles.js`.

- [ ] **Step 3: Add the table to the schema**

In `apps/backend/src/db/schema.ts`, inside the existing `db.exec(\`...\`)` template in `openDb`, after the `events` index:

```sql
    CREATE TABLE IF NOT EXISTS streamer_profiles (
      login      TEXT PRIMARY KEY,
      -- NULL means "asked Twitch, no avatar". A missing row means
      -- "never asked" -- collapsing the two would re-fetch an
      -- avatarless channel on every single poll, forever.
      avatar_url TEXT,
      fetched_at INTEGER NOT NULL
    );
```

- [ ] **Step 4: Write the `Profiles` class**

Create `apps/backend/src/db/profiles.ts`:

```ts
import type { Db } from "./schema.js";

export interface ProfileRow {
  login: string;
  avatarUrl: string | null;
  fetchedAt: number;
}

/**
 * The cached Twitch profile picture URL for each known login.
 *
 * Separate from `History` because that class owns points and events --
 * time series that grow forever -- while this is a small key/value cache
 * with a completely different lifecycle.
 */
export class Profiles {
  constructor(private readonly db: Db) {}

  get(logins: string[]): Map<string, ProfileRow> {
    const out = new Map<string, ProfileRow>();
    // An empty IN () is a SQL syntax error, and there is nothing to ask
    // for anyway.
    if (logins.length === 0) return out;
    const holes = logins.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT login, avatar_url, fetched_at
           FROM streamer_profiles WHERE login IN (${holes})`,
      )
      .all(...logins) as { login: string; avatar_url: string | null; fetched_at: number }[];
    for (const row of rows) {
      out.set(row.login, {
        login: row.login,
        avatarUrl: row.avatar_url,
        fetchedAt: row.fetched_at,
      });
    }
    return out;
  }

  put(login: string, avatarUrl: string | null, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO streamer_profiles (login, avatar_url, fetched_at)
         VALUES (?, ?, ?)
         ON CONFLICT(login) DO UPDATE SET avatar_url = excluded.avatar_url,
                                          fetched_at = excluded.fetched_at`,
      )
      .run(login, avatarUrl, ts);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test -- profiles`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/db/schema.ts apps/backend/src/db/profiles.ts apps/backend/src/db/profiles.test.ts
git commit -m "feat: cache table for streamer profile avatars

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `AvatarCache` — TTL, batch cap, and error swallowing

**Files:**
- Create: `apps/backend/src/state/avatars.ts`
- Test: `apps/backend/src/state/avatars.test.ts`

**Interfaces:**
- Consumes: `Profiles` and `ProfileRow` from `../db/profiles.js` (Task 1); `normaliseUsername` from `./roster.js`.
- Produces:
  - `const AVATAR_TTL_MS = 604_800_000`
  - `const MAX_FETCH_PER_PASS = 10`
  - `interface AvatarCacheDeps { profiles: Profiles; client: { request<T>(op: string, params?: object): Promise<T> }; now?: () => number }`
  - `class AvatarCache`, constructed as `new AvatarCache(deps: AvatarCacheDeps)`, with `resolve(logins: string[]): Promise<Map<string, string | null>>` — keyed by **normalised** login, one entry per input login, value `null` when unknown or absent.

The helper op contract this consumes (implemented in Task 3): `request<{ avatars: Record<string, string | null> }>("avatars", { streamers: string[] })`.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/state/avatars.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test -- avatars`
Expected: FAIL — cannot resolve `./avatars.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/backend/src/state/avatars.ts`:

```ts
import type { Profiles } from "../db/profiles.js";
import { normaliseUsername } from "./roster.js";

/**
 * How long a cached avatar URL is trusted. Streamers change their picture
 * rarely, so a week keeps the roster current at roughly one GQL call per
 * streamer per week.
 */
export const AVATAR_TTL_MS = 604_800_000;

/**
 * Lookups performed in a single pass. Turning on "mine my followed
 * channels" can add fifty logins at once; fetching them all in one tick
 * would fire fifty GQL calls and put the batch at risk of NdjsonClient's
 * 30s request timeout. The remainder are picked up by later refreshes --
 * an avatar arriving a minute late costs nothing.
 */
export const MAX_FETCH_PER_PASS = 10;

export interface AvatarCacheDeps {
  profiles: Profiles;
  client: { request<T>(op: string, params?: object): Promise<T> };
  now?: () => number;
}

/**
 * Resolves profile picture URLs, hitting Twitch only for logins that are
 * unknown or stale.
 *
 * Never rejects. A refresh's balances are the dashboard's reason to
 * exist; an avatar is decoration, and decoration must not be able to fail
 * the thing it decorates.
 */
export class AvatarCache {
  constructor(private readonly deps: AvatarCacheDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async resolve(logins: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    // Normalise up front so the cache keys match the roster's own dedupe
    // keys: a config entry spelled "Alpha" and a follow spelled "alpha"
    // are one channel and must share one row.
    const wanted = [...new Set(logins.map(normaliseUsername))].filter((l) => l !== "");
    if (wanted.length === 0) return out;

    const at = this.now();
    const cached = this.deps.profiles.get(wanted);
    const stale: string[] = [];

    for (const login of wanted) {
      const row = cached.get(login);
      if (row !== undefined && at - row.fetchedAt <= AVATAR_TTL_MS) {
        out.set(login, row.avatarUrl);
      } else {
        // Seed with whatever we last knew (or null). If the fetch below
        // is capped out or fails, this is what the caller gets -- a
        // slightly old picture beats no picture.
        out.set(login, row?.avatarUrl ?? null);
        stale.push(login);
      }
    }

    if (stale.length === 0) return out;
    const batch = stale.slice(0, MAX_FETCH_PER_PASS);

    try {
      const data = await this.deps.client.request<{
        avatars: Record<string, string | null>;
      }>("avatars", { streamers: batch });
      for (const login of batch) {
        // An omitted login means the helper found nothing for it. Cache
        // that as null rather than leaving no row, so it is not retried
        // on every refresh.
        const url = data.avatars?.[login] ?? null;
        this.deps.profiles.put(login, url, at);
        out.set(login, url);
      }
    } catch {
      // Swallowed deliberately -- see the class docstring. The seeded
      // entries above stand, and the next refresh tries again.
    }

    return out;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test -- avatars`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/state/avatars.ts apps/backend/src/state/avatars.test.ts
git commit -m "feat: avatar cache with TTL, batch cap and safe failure

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The `avatars` op on the Python helper

**Files:**
- Modify: `python/helpers/state.py`
- Test: `python/tests/test_state.py`

**Interfaces:**
- Consumes: the miner's `session.gql.video_player_stream_info_overlay_channel(login)`, whose response exposes `.user.profile_image_url` (see `vendor/miner/TwitchChannelPointsMiner/classes/gql/data/response/VideoPlayerStreamInfoOverlayChannel.py`).
- Produces: request `{"op": "avatars", "streamers": [...]}` → `{"ok": true, "data": {"avatars": {login: url_or_null}}}`. This is the contract Task 2 already codes against.

Error handling mirrors the existing `_state` method: a per-name failure degrades to `None`, an auth failure breaks out and propagates so `handle()` classifies it as `code: "AUTH"`.

- [ ] **Step 1: Write the failing tests**

The existing `FakeGQL` in `python/tests/test_state.py` needs an avatar source. Add an `avatars` argument and a method to it, then add the tests.

Change the `FakeGQL.__init__` signature and body to:

```python
class FakeGQL:
    def __init__(self, balances=None, live=None, follows=None, avatars=None):
        self.balances = balances or {}
        self.live = live or {}
        self.follows = follows or []
        self.avatars = avatars or {}

    def video_player_stream_info_overlay_channel(self, username):
        value = self.avatars.get(username)
        if isinstance(value, Exception):
            raise value
        return SimpleNamespace(user=SimpleNamespace(profile_image_url=value))
```

(Keep every existing method on the class as-is.)

Then append these tests to `python/tests/test_state.py`:

```python
def test_avatars_returns_a_login_to_url_mapping():
    h = handler(avatars={"alpha": "https://cdn/a.png", "beta": "https://cdn/b.png"})
    out = h.handle({"id": 1, "op": "avatars", "streamers": ["alpha", "beta"]})
    assert out["ok"] is True
    assert out["data"]["avatars"] == {
        "alpha": "https://cdn/a.png",
        "beta": "https://cdn/b.png",
    }


def test_avatars_reports_none_for_a_channel_without_one():
    h = handler(avatars={"alpha": None})
    out = h.handle({"id": 1, "op": "avatars", "streamers": ["alpha"]})
    assert out["data"]["avatars"] == {"alpha": None}


def test_one_failing_name_does_not_lose_the_rest_of_the_batch():
    h = handler(avatars={
        "alpha": RuntimeError("channel is gone"),
        "beta": "https://cdn/b.png",
    })
    out = h.handle({"id": 1, "op": "avatars", "streamers": ["alpha", "beta"]})
    assert out["ok"] is True
    assert out["data"]["avatars"] == {"alpha": None, "beta": "https://cdn/b.png"}


def test_auth_failure_propagates_rather_than_degrading_to_null():
    # A dead session must be reported, not quietly rendered as a roster of
    # monograms -- the user needs the sign-in prompt.
    response = requests.Response()
    response.status_code = 401
    h = handler(avatars={
        "alpha": requests.exceptions.HTTPError(response=response),
    })
    h.session.is_logged_in = lambda: False
    out = h.handle({"id": 1, "op": "avatars", "streamers": ["alpha"]})
    assert out["ok"] is False
    assert out["code"] == "AUTH"


def test_avatars_requires_the_streamers_field():
    h = handler()
    out = h.handle({"id": 1, "op": "avatars"})
    assert out["ok"] is False
    assert out["code"] == "BAD_REQUEST"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest python/tests/test_state.py -k avatar -v`
Expected: FAIL — the op is unknown, so `ok` is `False` with `code: "BAD_REQUEST"` and the mapping assertions fail.

- [ ] **Step 3: Add the op to the handler**

In `python/helpers/state.py`, inside `Handler.handle`, after the `state` branch:

```python
            if op == "avatars":
                return {"id": req_id, "ok": True,
                        "data": {"avatars": self._avatars(req["streamers"])}}
```

Then add the method next to `_state`:

```python
    def _avatars(self, usernames: list[str]) -> dict:
        """Profile picture URL per login, or None where there is none.

        Shaped like _state's loop for the same reason: one unreachable
        channel must not cost the whole batch, but an auth failure is
        about the session rather than the channel and has to reach
        handle() so it can be reported as AUTH. Degrading that to a null
        avatar would leave a signed-out user staring at monograms with no
        prompt to sign in again.
        """
        out = {}
        auth_error = None
        for username in usernames:
            try:
                response = self.session.gql.video_player_stream_info_overlay_channel(
                    username
                )
                out[username] = getattr(response.user, "profile_image_url", None) or None
            except Exception as exc:
                if _is_auth_error(exc):
                    auth_error = exc
                    break
                out[username] = None
        if auth_error is not None:
            raise auth_error
        return out
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest python/tests/test_state.py -v`
Expected: PASS — the five new tests plus every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add python/helpers/state.py python/tests/test_state.py
git commit -m "feat: avatars op on the state helper

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Attach `avatarUrl` to `StreamerState`

**Files:**
- Modify: `apps/backend/src/state/service.ts`
- Modify: `apps/backend/src/index.ts`
- Test: `apps/backend/src/state/service.test.ts`

**Interfaces:**
- Consumes: `AvatarCache` from `./avatars.js` (Task 2).
- Produces: `StreamerState.avatarUrl: string | null`, present on every entry of the `/api/streamers` snapshot and the SSE `state` frame. `StateServiceDeps` gains an optional `avatars?: { resolve(logins: string[]): Promise<Map<string, string | null>> }` — optional so the many existing tests in `service.test.ts` that construct a `StateService` without one keep working unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/src/state/service.test.ts`:

```ts
test("attaches the resolved avatar url to each streamer", async () => {
  const { service } = make([alpha(100)]);
  (service as never as { deps: { avatars: unknown } }).deps.avatars = {
    resolve: async () => new Map([["alpha", "https://cdn/a.png"]]),
  };
  await service.refresh();
  expect(service.snapshot().streamers[0].avatarUrl).toBe("https://cdn/a.png");
});

test("avatarUrl is null when no avatar cache is wired in", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].avatarUrl).toBe(null);
});

test("a rejecting avatar cache leaves the balances intact and the state clean", async () => {
  // The dashboard's actual job is the numbers. An avatar lookup that
  // blows up must not mark the snapshot stale or blank the roster.
  const { service } = make([alpha(100)]);
  (service as never as { deps: { avatars: unknown } }).deps.avatars = {
    resolve: async () => { throw new Error("cache exploded"); },
  };
  await service.refresh();
  const snapshot = service.snapshot();
  expect(snapshot.streamers[0].points).toBe(100);
  expect(snapshot.streamers[0].avatarUrl).toBe(null);
  expect(snapshot.error).toBe(null);
  expect(snapshot.stale).toBe(false);
});

test("a stable avatar url does not emit a change frame on every tick", async () => {
  // avatarUrl joins the JSON.stringify change comparison, so a value that
  // varied per tick would wake every SSE client once a minute forever.
  const { service } = make([alpha(100), alpha(100)]);
  (service as never as { deps: { avatars: unknown } }).deps.avatars = {
    resolve: async () => new Map([["alpha", "https://cdn/a.png"]]),
  };
  const changes = vi.fn();
  await service.refresh();
  service.on("change", changes);
  await service.refresh();
  expect(changes).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test -- service`
Expected: FAIL — `avatarUrl` is `undefined`, not `null` or a URL.

- [ ] **Step 3: Implement**

In `apps/backend/src/state/service.ts`:

Add to the `StreamerState` interface, after `spark`:

```ts
  /**
   * Twitch CDN profile picture URL, or null when the channel has none or
   * we have not resolved it yet. A stable string, so it can join the
   * change comparison without waking SSE clients every tick.
   */
  avatarUrl: string | null;
```

Widen the `RawStreamerState` omission — the helper's `state` op does not report avatars, so it must be excluded alongside the other derived fields:

```ts
export type RawStreamerState = Omit<
  StreamerState,
  "gained24h" | "gainedSince" | "gainedStream" | "spark" | "avatarUrl"
>;
```

Add to `StateServiceDeps`:

```ts
  /**
   * Optional so tests (and a boot before the cache exists) can run
   * without one. Absent, every streamer simply reports a null avatar.
   */
  avatars?: { resolve(logins: string[]): Promise<Map<string, string | null>> };
```

In `doRefresh`, after the `const data = await ...request(...)` line and before `const before = ...`:

```ts
      // Resolved after the state response is in hand, so an avatar lookup
      // can never widen the balance poll it rides along with. Failures are
      // swallowed here as well as inside AvatarCache: this must degrade to
      // monograms, never to a stale or errored snapshot.
      const avatars = this.deps.avatars
        ? await this.deps.avatars
            .resolve(data.streamers.map((s) => s.username))
            .catch(() => new Map<string, string | null>())
        : new Map<string, string | null>();
```

In the `.map()` that builds each streamer, add to the returned object:

```ts
          avatarUrl: avatars.get(normaliseUsername(s.username)) ?? null,
```

and import the helper at the top of the file:

```ts
import { normaliseUsername } from "./roster.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test`
Expected: PASS — the whole backend suite, including every pre-existing `service` test.

- [ ] **Step 5: Wire it up at boot**

In `apps/backend/src/index.ts`, alongside the existing `History` construction, build the cache and pass it to `StateService`:

```ts
import { Profiles } from "./db/profiles.js";
import { AvatarCache } from "./state/avatars.js";
```

```ts
const profiles = new Profiles(db);
const avatars = new AvatarCache({ profiles, client: helper });
```

and add `avatars,` to the `new StateService({ ... })` options object.

Read the surrounding lines before editing: match the existing variable names for the database handle and the helper client rather than assuming `db` and `helper`.

- [ ] **Step 6: Verify the backend still builds and boots**

Run: `pnpm --filter @app/backend build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/state/service.ts apps/backend/src/state/service.test.ts apps/backend/src/index.ts
git commit -m "feat: serve avatar urls on the streamer state frame

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `StreamerAvatar` component

**Files:**
- Create: `apps/frontend/src/components/StreamerAvatar.tsx`
- Modify: `apps/frontend/src/api/useLiveState.ts`
- Test: `apps/frontend/src/components/StreamerAvatar.test.tsx`

**Interfaces:**
- Consumes: `Avatar` from `@mantine/core` (v9.6.0).
- Produces: `StreamerAvatar`, a component taking
  `{ login: string; displayName?: string | null; avatarUrl: string | null; size?: number; live?: boolean }`.
  It renders an anchor to `https://twitch.tv/<login>` wrapping the avatar.

Mantine 9's `Avatar` already does the fallback this needs: it holds an `error` state initialised from `!src`, resets it when `src` changes, and sets it from the image's `onError` (verified in `@mantine/core@9.6.0`, `Avatar.mjs:37,51,65`). So a null URL *and* a URL whose image 404s both fall through to `children`. `color="initials"` derives a stable hue from `name` via Mantine's shipped `get-initials-color`, so no hand-rolled hash is needed.

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/components/StreamerAvatar.test.tsx`:

```tsx
import { expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { renderApp } from "../test-utils.js";
import { StreamerAvatar } from "./StreamerAvatar.js";

test("links to the streamer's twitch channel", () => {
  renderApp(<StreamerAvatar login="alpha" displayName="Alpha" avatarUrl={null} />);
  const link = screen.getByRole("link");
  expect(link).toHaveAttribute("href", "https://twitch.tv/alpha");
});

test("opens in a new tab without handing twitch a window handle", () => {
  renderApp(<StreamerAvatar login="alpha" displayName="Alpha" avatarUrl={null} />);
  const link = screen.getByRole("link");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("links by login even when the display name differs", () => {
  // Display names can be non-ASCII and do not resolve as URLs.
  renderApp(<StreamerAvatar login="alpha" displayName="アルファ" avatarUrl={null} />);
  expect(screen.getByRole("link")).toHaveAttribute("href", "https://twitch.tv/alpha");
});

test("renders the image when a url is present", () => {
  renderApp(
    <StreamerAvatar login="alpha" displayName="Alpha" avatarUrl="https://cdn/a.png" />,
  );
  expect(screen.getByRole("img")).toHaveAttribute("src", "https://cdn/a.png");
});

test("renders a monogram when there is no url", () => {
  renderApp(<StreamerAvatar login="alpha" displayName="Alpha" avatarUrl={null} />);
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText("A")).toBeInTheDocument();
});

test("falls back to the login when there is no display name", () => {
  renderApp(<StreamerAvatar login="beta" displayName={null} avatarUrl={null} />);
  expect(screen.getByText("B")).toBeInTheDocument();
});

test("labels the link for screen readers", () => {
  // The image itself is decorative -- the name sits right beside it --
  // so the accessible name has to come from the link.
  renderApp(<StreamerAvatar login="alpha" displayName="Alpha" avatarUrl={null} />);
  expect(screen.getByRole("link", { name: /Alpha on Twitch/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/frontend test -- StreamerAvatar`
Expected: FAIL — cannot resolve `./StreamerAvatar.js`.

- [ ] **Step 3: Write the component**

Create `apps/frontend/src/components/StreamerAvatar.tsx`:

```tsx
import { Avatar } from "@mantine/core";

/**
 * A streamer's profile picture, linking to their Twitch channel.
 *
 * The href is built from the login, never the display name: display names
 * carry non-ASCII characters on plenty of channels and do not resolve as
 * URLs, while the login is the canonical channel path.
 *
 * Mantine's Avatar handles both failure modes on its own -- a null src and
 * an image that 404s -- by falling back to `children`, so a dead CDN URL
 * degrades to the monogram with no extra code here. `color="initials"`
 * derives a stable hue from the name, so a given streamer keeps the same
 * colour across renders and reloads.
 */
export function StreamerAvatar({ login, displayName, avatarUrl, size = 40, live = false }: {
  login: string;
  displayName?: string | null;
  avatarUrl: string | null;
  size?: number;
  live?: boolean;
}) {
  const name = displayName ?? login;
  return (
    <a
      href={`https://twitch.tv/${login}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${name} on Twitch`}
      style={{ display: "flex", flexShrink: 0, lineHeight: 0 }}
    >
      <Avatar
        src={avatarUrl}
        // Decorative: the name is always rendered next to it, and a
        // screen reader must not announce the same streamer twice.
        alt=""
        name={name}
        color="initials"
        size={size}
        radius="xl"
        style={live
          ? { outline: "2px solid var(--tw-live)", outlineOffset: 2 }
          : undefined}
      >
        {name.charAt(0).toUpperCase()}
      </Avatar>
    </a>
  );
}
```

- [ ] **Step 4: Add the field to the frontend state type**

In `apps/frontend/src/api/useLiveState.ts`, add to the `StreamerState` interface, after `spark`:

```ts
  avatarUrl: string | null;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @app/frontend test -- StreamerAvatar`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/components/StreamerAvatar.tsx apps/frontend/src/components/StreamerAvatar.test.tsx apps/frontend/src/api/useLiveState.ts
git commit -m "feat: streamer avatar component with monogram fallback

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Avatars on the dashboard cards

**Files:**
- Modify: `apps/frontend/src/components/StreamerCard.tsx`
- Test: `apps/frontend/src/components/StreamerCard.test.tsx`

**Interfaces:**
- Consumes: `StreamerAvatar` (Task 5), `StreamerState.avatarUrl` (Tasks 4 and 5).
- Produces: no new exports; `StreamerCard`'s rendered output gains a linked avatar.

- [ ] **Step 1: Write the failing tests**

This file already has a `base: StreamerState` fixture and a `view(partial)` helper that wraps `render` in a `MantineProvider`. Add `avatarUrl: null` to `base` (required, or the file stops type-checking once Task 5 adds the field), and use the existing `view()` helper rather than calling `render` directly. Then append:

```tsx
test("shows a linked avatar for the streamer", () => {
  view({ avatarUrl: "https://cdn/a.png" });
  const link = screen.getByRole("link", { name: /on Twitch/i });
  expect(link).toHaveAttribute("href", "https://twitch.tv/alpha");
  expect(screen.getByRole("img")).toHaveAttribute("src", "https://cdn/a.png");
});

test("shows a monogram when the avatar is not known yet", () => {
  view({ avatarUrl: null });
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("link", { name: /on Twitch/i })).toBeInTheDocument();
});

test("the streamer's name links to their channel", () => {
  view({ avatarUrl: null });
  const nameLink = screen.getByRole("link", { name: "Alpha" });
  expect(nameLink).toHaveAttribute("href", "https://twitch.tv/alpha");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/frontend test -- StreamerCard`
Expected: FAIL — no link role is found.

- [ ] **Step 3: Implement**

In `apps/frontend/src/components/StreamerCard.tsx`, import the component:

```tsx
import { StreamerAvatar } from "./StreamerAvatar.js";
```

Replace the name `<Text>` inside the header `Group` with an avatar plus a linked name. The existing line is:

```tsx
          <Text fw={600} truncate>{s.displayName ?? s.username}</Text>
```

Replace it with:

```tsx
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <StreamerAvatar
              login={s.username}
              displayName={s.displayName}
              avatarUrl={s.avatarUrl}
              size={40}
              live={live}
            />
            {/* Its own link rather than one anchor around both: the name
                truncates and the avatar must not, so they cannot share a
                box, and a separate link keeps each one's accessible name
                honest. */}
            <Text
              component="a"
              href={`https://twitch.tv/${s.username}`}
              target="_blank"
              rel="noopener noreferrer"
              fw={600}
              truncate
              className={classes.name}
            >
              {s.displayName ?? s.username}
            </Text>
          </Group>
```

Add to `apps/frontend/src/components/StreamerCard.module.css`:

```css
/* Inherit the card's text colour rather than the browser's link blue --
   the name is a heading that happens to be clickable. */
.name {
  color: inherit;
  text-decoration: none;
}

.name:hover {
  color: var(--tw-purple);
  text-decoration: underline;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/frontend test`
Expected: PASS — the whole frontend suite, including the pre-existing `StreamerCard` and `Dashboard` tests.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/StreamerCard.tsx apps/frontend/src/components/StreamerCard.module.css apps/frontend/src/components/StreamerCard.test.tsx
git commit -m "feat: avatars and channel links on dashboard cards

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Avatars on the Streamers config rows

**Files:**
- Modify: `apps/frontend/src/routes/Streamers.tsx`
- Test: `apps/frontend/src/routes/Streamers.test.tsx`

**Interfaces:**
- Consumes: `StreamerAvatar` (Task 5); the existing `/api/streamers` snapshot for URLs.
- Produces: no new exports.

The config rows come from `/api/config`, which carries no avatar. This screen reads the live state separately for URLs and falls back to monograms when the miner is stopped. **The screen must stay fully usable with the miner down** — a failed state fetch here changes nothing but the pictures.

- [ ] **Step 1: Write the failing tests**

This file stubs `fetch` globally in `beforeEach` (not `api.get`) and renders via `renderApp` from `../test-utils.js`. Note the existing handler order matters: the `/api/streamers/lookup` branch is checked with `startsWith` before anything else, so the new exact-match branch for `/api/streamers` must come **after** it, or it would swallow lookup calls and break the existing add-streamer tests.

Add this branch to the existing `fetch` stub, immediately after the `/api/config` branch:

```tsx
    if (url === "/api/streamers") {
      return { ok: true, status: 200, json: async () => ({
        streamers: [{ username: "alpha", avatarUrl: "https://cdn/a.png" }],
      }) };
    }
```

Then append:

```tsx
test("shows an avatar and a channel link per configured streamer", async () => {
  renderApp(<Streamers />);
  const link = await screen.findByRole("link", { name: /alpha on Twitch/i });
  expect(link).toHaveAttribute("href", "https://twitch.tv/alpha");
  expect(await screen.findByRole("img")).toHaveAttribute("src", "https://cdn/a.png");
});

test("stays usable when the live state cannot be loaded", async () => {
  // The miner being stopped must cost the config screen its pictures and
  // nothing else -- this is the screen you use to fix a broken setup.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/config") {
      return { ok: true, status: 200, json: async () => config };
    }
    throw new Error("miner is stopped");
  }));
  renderApp(<Streamers />);
  expect(await screen.findByText("alpha")).toBeInTheDocument();
  expect(screen.getAllByTestId("streamer-row").length).toBe(2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/frontend test -- Streamers`
Expected: FAIL — no link is found for the first test.

- [ ] **Step 3: Implement**

In `apps/frontend/src/routes/Streamers.tsx`:

```tsx
import { StreamerAvatar } from "../components/StreamerAvatar.js";
```

Add a second load beside the existing config `useEffect`:

```tsx
  const [avatars, setAvatars] = useState<Map<string, string | null>>(new Map());

  useEffect(() => {
    // Pictures only. A failure here must not touch `loadError` -- the
    // config screen has to work with the miner stopped, which is exactly
    // when someone is most likely to be on it.
    api.get<{ streamers: { username: string; avatarUrl: string | null }[] }>(
      "/api/streamers",
    )
      .then((snapshot) => {
        setAvatars(new Map(
          snapshot.streamers.map((s) => [s.username.toLowerCase(), s.avatarUrl]),
        ));
      })
      .catch(() => {});
  }, []);
```

In the row's inner `<Group gap="sm" wrap="nowrap">`, insert the avatar between the index `<Text>` and the name `<Text>`:

```tsx
                <StreamerAvatar
                  login={streamer.username}
                  avatarUrl={avatars.get(streamer.username.toLowerCase()) ?? null}
                  size={28}
                />
```

and make the name a link by replacing:

```tsx
                <Text fw={500}>{streamer.username}</Text>
```

with:

```tsx
                <Text
                  component="a"
                  href={`https://twitch.tv/${streamer.username}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  fw={500}
                  style={{ color: "inherit", textDecoration: "none" }}
                >
                  {streamer.username}
                </Text>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/frontend test`
Expected: PASS — the whole frontend suite.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/routes/Streamers.tsx apps/frontend/src/routes/Streamers.test.tsx
git commit -m "feat: avatars and channel links on the streamers screen

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Full-suite verification

**Files:** none modified unless a failure is found.

- [ ] **Step 1: Run every suite**

```bash
pnpm --filter @app/backend test
pnpm --filter @app/frontend test
uv run pytest python/tests/
pnpm --filter @app/backend build
```

Expected: all green, no TypeScript errors. Fix anything that fails before continuing — in particular, any pre-existing test fixture that now needs an `avatarUrl` field to type-check.

- [ ] **Step 2: Verify against a real miner**

Run `pnpm dev`, open the Vite URL, and confirm on the dashboard:

- avatars appear on cards within one refresh cycle (up to 60s on first run);
- a live streamer's avatar carries the live-coloured ring;
- clicking an avatar and clicking a name both open the right Twitch channel in a new tab;
- the Streamers screen shows the same faces;
- stopping the miner leaves the Streamers screen fully usable.

Then confirm the cache is doing its job:

```bash
sqlite3 .devdata/history.db "SELECT login, substr(avatar_url,1,50), fetched_at FROM streamer_profiles;"
```

Expected: one row per streamer seen so far. Watch the backend log across a second refresh — there must be **no** further `avatars` helper request once every roster login has a fresh row.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found in avatar end-to-end verification

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| `streamer_profiles` table, nullable `avatar_url` | 1 |
| `AvatarCache`, TTL, batch cap, error swallowing | 2 |
| `avatars` op, per-name degradation, auth propagation | 3 |
| `StreamerState.avatarUrl` on the existing frame | 4 |
| `StreamerAvatar`, monogram fallback, live ring, `alt=""` | 5 |
| Links by login, `rel="noopener noreferrer"` | 5, 6, 7 |
| Dashboard cards surface | 6 |
| Streamers config rows surface, usable miner-down | 7 |
| No proxy / no disk bytes / no manual refresh (out of scope) | not implemented, by design |

**Type consistency** — `resolve(logins: string[]): Promise<Map<string, string | null>>` is defined in Task 2 and consumed identically in Task 4. `avatarUrl: string | null` is defined in Task 4 and mirrored in Task 5's `useLiveState.ts`, then consumed in Tasks 6 and 7. `Profiles.get`/`put` signatures from Task 1 are used unchanged in Task 2. The helper contract `{avatars: Record<string, string | null>}` is written in Task 3 and coded against in Task 2.

**Ordering note:** Task 2 is written against the helper op that Task 3 implements. This is deliberate — Task 2's tests stub the client, so it is independently testable — but the feature does not work end to end until Task 3 lands. Do not skip Task 3.
