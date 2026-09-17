# Drop Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Drops section that lists every running Twitch drop campaign with per-drop progress, and lets the user subscribe to a campaign or game so the app keeps suitable channels in the miner's config automatically.

**Architecture:** Campaign data comes from the vendored miner's private GraphQL layer through two new ops in the existing NDJSON helper (`python/helpers/state.py`). Three separate caches on three separate clocks: a 24h disk-backed campaign catalogue, in-memory inventory progress on the existing 10-minute drops clock, and a ~15-minute reconciliation pass that resolves subscription intent into concrete channels. Restarts triggered by reconciliation are deferred 60s behind a cancellable SSE banner, sitting above `MinerSupervisor` rather than inside it.

**Tech Stack:** TypeScript (Node 24, ESM, `.js` import specifiers), Fastify 5, Zod 4, vitest 5, better-sqlite3; Python 3 with pytest for the helper; React frontend with Mantine.

**Spec:** `docs/superpowers/specs/2026-09-17-drop-campaigns-design.md`

## Phasing note

The spec covers two subsystems that were deliberately kept in one spec. This plan sequences rather than splits them:

- **Phase 1 (Tasks 1-8)** delivers the read-only Drops browser. It is shippable on its own — a user gets a working campaign browser with progress even if Phase 2 is never built.
- **Phase 2 (Tasks 9-15)** delivers the subscription engine, which consumes Phase 1's catalogue.

Stop after Task 8 and you have working, tested, useful software. That is the property the phase boundary exists to guarantee.

## Global Constraints

- **Node >= 24**, ESM throughout. Relative imports MUST carry the `.js` extension (e.g. `import { x } from "./y.js"`) even in TypeScript source — the build is `tsc` emitting real ESM.
- **Package manager is pnpm.** Backend tests: `pnpm --filter @app/backend test`. Python tests: `pytest` from the repo root.
- **Never assert a figure the data does not support.** Absent data renders as unknown (em-dash / no bar), never as zero. Precedent: `Gain.tsx:30`, `StreamerCard.tsx:120`.
- **Python helper reads every miner field with `getattr(obj, "field", default)`.** A miner build whose parser predates a field must degrade to a missing value, never fail the batch. Precedent: `_profile` and `_next_drop` in `python/helpers/state.py`.
- **`datetime` is not JSON serialisable.** Every date crossing the NDJSON boundary is converted to epoch ms (`int(dt.timestamp() * 1000)`) or it raises inside `serve()`'s `json.dumps`.
- **Tests run in the container's local timezone (Europe/Berlin), with no TZ pin.** Build day-based fixtures in local time.
- **Progress data is never persisted to disk.** Campaign metadata is. The distinction is the whole point of the three-clock design.
- **Unset miner booleans default ON.** Check `Streamer.default()` semantics before treating an absent boolean as off — precedent and reasoning in `dropsEligible.ts`.
- **Commit style:** Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`). Commit directly to `main`; do not open feature branches.

---

## File Structure

**Phase 1 — browser**

| File | Responsibility |
|---|---|
| `python/helpers/state.py` (modify) | Add `campaigns` and `inventory` ops beside the existing `drops` op |
| `python/tests/test_state.py` (modify) | Fixture-driven tests for both new ops |
| `apps/backend/src/state/campaignCatalogue.ts` (create) | 24h disk-backed campaign cache, manual refresh, stale-serve |
| `apps/backend/src/state/campaignCatalogue.test.ts` (create) | TTL, persistence, stale-serve, refresh rate limit |
| `apps/backend/src/state/inventory.ts` (create) | 10-min in-memory progress cache, never persisted |
| `apps/backend/src/state/inventory.test.ts` (create) | TTL, failure → unknown (not zero) |
| `apps/backend/src/state/dropState.ts` (create) | Pure join of catalogue + inventory → six drop states |
| `apps/backend/src/state/dropState.test.ts` (create) | The six-state table, exhaustively |
| `apps/backend/src/http/server.ts` (modify) | `GET /api/campaigns`, `POST /api/campaigns/refresh` |
| `apps/frontend/src/routes/Drops.tsx` (create) | The screen: list, expand, filter |
| `apps/frontend/src/components/CampaignCard.tsx` (create) | One campaign + its drops |
| `apps/frontend/src/components/DropRow.tsx` (create) | One drop, rendering its state |
| `apps/frontend/src/app.tsx` (modify) | Register the `drops` screen in `SCREENS` and the nav |

**Phase 2 — engine**

| File | Responsibility |
|---|---|
| `apps/backend/src/config/schema.ts` (modify) | `subscriptions[]`, and `ownedBy` on streamer entries |
| `apps/backend/src/drops/resolution.ts` (create) | campaign + directory → ranked candidate channels |
| `apps/backend/src/drops/resolution.test.ts` (create) | allowlist path, directory path, directory-unavailable |
| `apps/backend/src/drops/reconcile.ts` (create) | **Pure.** desired vs current config → diff + restart verdict |
| `apps/backend/src/drops/reconcile.test.ts` (create) | Every add/remove/reorder/no-op case |
| `apps/backend/src/drops/pendingRestart.ts` (create) | 60s deferral, cancel, restart-now |
| `apps/backend/src/drops/pendingRestart.test.ts` (create) | Fake-timer expire/cancel/re-propose |
| `apps/backend/src/drops/engine.ts` (create) | Wires the three above onto the 15-min timer |
| `python/helpers/state.py` (modify) | `directory` op for live channels by game |
| `apps/frontend/src/components/RestartBanner.tsx` (create) | The cancellable countdown |

**Frontend conventions (verified — follow these, they are not negotiable):**
- Screens live in `apps/frontend/src/routes/`, **not** a `pages/` directory, and are registered in the `SCREENS` map in `app.tsx:26`.
- Components render in tests via `renderApp` / `renderLive` from `apps/frontend/src/test-utils.js` — **never** a bare `render()`, because a bare `<MantineProvider>` uses Mantine's default theme and asserts against a theme the app never ships.
- Network is stubbed with `vi.stubGlobal("fetch", ...)` returning `{ ok, status, json }`, as `routes/Streamers.test.tsx` does. Do **not** add fetcher props for testability; that is not how this codebase tests.
- HTTP goes through the `api` object in `api/client.ts` (`api.get`, `api.post`, `api.put`). **`api` has no `delete` method** — Task 14 needs one added, or must use `POST` for removal.
- Reordering uses `@dnd-kit` (already a dependency), following `routes/Streamers.tsx`. Drag tests need `stubRowRects()`/`restoreRects()` from `test-utils.js`, because jsdom reports every rect as 0x0 and a drag would otherwise "succeed" while reordering nothing.
- `@tanstack/react-query` is in `package.json` but is **not** used by any existing route. Do not introduce it here.

---

# PHASE 1 — The Drops Browser

### Task 1: Python `campaigns` op

**Files:**
- Modify: `python/helpers/state.py` (add `_campaigns`, dispatch in `Handler.handle`)
- Test: `python/tests/test_state.py`

**Interfaces:**
- Consumes: the session's `gql` object, as `_drops` does (`self.session.gql`).
- Produces: NDJSON op `"campaigns"`, no params, returning
  `{"campaigns": [{"id": str, "name": str, "game": {"id": str, "slug": str, "displayName": str} | None, "startsAt": int|None, "endsAt": int|None, "allowChannelIds": [str], "drops": [{"id": str, "name": str, "benefits": [str], "requiredMinutes": int, "requiredSubs": int}]}]}`

- [ ] **Step 1: Write the failing test**

```python
def campaign_details(cid="c1", name="Campaign One", drops=()):
    """Mirrors DropCampaignDetails as upstream's parser produces it."""
    return SimpleNamespace(
        id=cid,
        name=name,
        status="ACTIVE",
        game=SimpleNamespace(id="g1", slug="a-game", display_name="A Game"),
        allow_channel_ids=["100", "200"],
        start_at=datetime.datetime(2026, 9, 1, 12, 0),
        end_at=datetime.datetime(2026, 9, 30, 12, 0),
        time_based_drops=list(drops),
    )


def drop_details(did="d1", minutes=60, subs=0):
    return SimpleNamespace(
        id=did,
        name="Crate",
        benefits=["Crate", "Crate"],
        required_minutes_watched=minutes,
        required_subs=subs,
        start_at=datetime.datetime(2026, 9, 1, 12, 0),
        end_at=datetime.datetime(2026, 9, 30, 12, 0),
    )


def test_campaigns_flattens_active_campaigns():
    details = campaign_details(drops=[drop_details()])
    session = SimpleNamespace(
        gql=SimpleNamespace(
            get_viewer_drops_dashboard=lambda: SimpleNamespace(
                campaigns=[SimpleNamespace(id="c1", status="ACTIVE")]
            ),
            get_drop_campaign_details=lambda ids: [
                SimpleNamespace(campaign=details)
            ],
        ),
        is_logged_in=lambda: True,
        reload_cookies=lambda: None,
    )
    out = Handler(session).handle({"id": 1, "op": "campaigns"})
    assert out["ok"] is True
    campaign = out["data"]["campaigns"][0]
    assert campaign["id"] == "c1"
    assert campaign["game"]["displayName"] == "A Game"
    assert campaign["allowChannelIds"] == ["100", "200"]
    # Benefits are deduped: Twitch lists one edge per benefit instance,
    # so "Crate, Crate" would read as a bug.
    assert campaign["drops"][0]["benefits"] == ["Crate"]
    assert campaign["drops"][0]["requiredMinutes"] == 60
    # Epoch ms, not datetime -- json.dumps would raise on a datetime.
    assert isinstance(campaign["startsAt"], int)


def test_campaigns_skips_non_active():
    session = SimpleNamespace(
        gql=SimpleNamespace(
            get_viewer_drops_dashboard=lambda: SimpleNamespace(
                campaigns=[
                    SimpleNamespace(id="c1", status="EXPIRED"),
                    SimpleNamespace(id="c2", status="ACTIVE"),
                ]
            ),
            get_drop_campaign_details=lambda ids: (
                [SimpleNamespace(campaign=campaign_details(cid=ids[0]))]
            ),
        ),
        is_logged_in=lambda: True,
        reload_cookies=lambda: None,
    )
    out = Handler(session).handle({"id": 1, "op": "campaigns"})
    # Only the ACTIVE id was ever requested.
    assert [c["id"] for c in out["data"]["campaigns"]] == ["c2"]


def test_campaigns_tolerates_missing_fields():
    """A miner build whose parser predates a field must not fail the batch."""
    bare = SimpleNamespace(id="c1", name="Bare", status="ACTIVE",
                           time_based_drops=[])
    session = SimpleNamespace(
        gql=SimpleNamespace(
            get_viewer_drops_dashboard=lambda: SimpleNamespace(
                campaigns=[SimpleNamespace(id="c1", status="ACTIVE")]
            ),
            get_drop_campaign_details=lambda ids: [SimpleNamespace(campaign=bare)],
        ),
        is_logged_in=lambda: True,
        reload_cookies=lambda: None,
    )
    out = Handler(session).handle({"id": 1, "op": "campaigns"})
    campaign = out["data"]["campaigns"][0]
    assert campaign["game"] is None
    assert campaign["startsAt"] is None
    assert campaign["allowChannelIds"] == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pytest python/tests/test_state.py -k campaigns -v`
Expected: FAIL — `unknown op: campaigns` (the handler returns `ok: False`)

- [ ] **Step 3: Write minimal implementation**

Add module-level helpers near `_next_drop` in `python/helpers/state.py`:

```python
def _epoch_ms(value) -> int | None:
    """Epoch ms, or None. datetime is not JSON serialisable, so a raw
    datetime crossing the NDJSON boundary raises inside serve()'s
    json.dumps -- the same trap _next_drop documents for endsAt."""
    return int(value.timestamp() * 1000) if value is not None else None


def _game(game) -> dict | None:
    if game is None:
        return None
    return {
        "id": getattr(game, "id", None),
        "slug": getattr(game, "slug", None),
        "displayName": getattr(game, "display_name", None),
    }


def _campaign_drop(drop) -> dict:
    return {
        "id": getattr(drop, "id", None),
        "name": getattr(drop, "name", None) or "Drop",
        # Deduped, order preserved -- Twitch lists one edge per benefit
        # instance, so a drop granting two of an item repeats the name.
        "benefits": list(dict.fromkeys(getattr(drop, "benefits", None) or [])),
        "requiredMinutes": getattr(drop, "required_minutes_watched", 0) or 0,
        # A sub-gated drop can never be earned by watching: Drop.update
        # sets is_claimable False whenever subs_required > 0.
        "requiredSubs": getattr(drop, "required_subs", 0) or 0,
    }
```

Then the handler method:

```python
    def _campaigns(self) -> list[dict]:
        """Every ACTIVE drop campaign with its drops.

        Two GQL calls: the dashboard for ids (the query backing
        twitch.tv/drops/campaigns -- it returns every campaign, not only
        ones for channels we follow), then batched details for the rest.

        Deliberately does NOT call get_available_drops: that is keyed by
        channel and answers a roster question. This op answers "what
        campaigns exist", which the dashboard answers outright.
        """
        dashboard = self.session.gql.get_viewer_drops_dashboard()
        ids = [
            c.id
            for c in (getattr(dashboard, "campaigns", None) or [])
            if getattr(c, "status", None) == "ACTIVE"
        ]
        if not ids:
            return []
        out = []
        for response in self.session.gql.get_drop_campaign_details(ids):
            campaign = getattr(response, "campaign", None)
            if campaign is None:
                continue
            out.append({
                "id": getattr(campaign, "id", None),
                "name": getattr(campaign, "name", None) or "Campaign",
                "game": _game(getattr(campaign, "game", None)),
                "startsAt": _epoch_ms(getattr(campaign, "start_at", None)),
                "endsAt": _epoch_ms(getattr(campaign, "end_at", None)),
                "allowChannelIds": list(
                    getattr(campaign, "allow_channel_ids", None) or []
                ),
                "drops": [
                    _campaign_drop(d)
                    for d in (getattr(campaign, "time_based_drops", None) or [])
                ],
            })
        return out
```

And dispatch it in `Handler.handle`, directly after the `drops` branch:

```python
            if op == "campaigns":
                self._ensure_token()
                return {"id": req_id, "ok": True,
                        "data": {"campaigns": self._campaigns()}}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pytest python/tests/test_state.py -k campaigns -v`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the whole Python suite for regressions**

Run: `cd /workspace && pytest python/tests -q`
Expected: PASS, no existing test broken

- [ ] **Step 6: Commit**

```bash
git add python/helpers/state.py python/tests/test_state.py
git commit -m "feat(helper): add a campaigns op listing active drop campaigns"
```

---

### Task 2: Python `inventory` op

**Files:**
- Modify: `python/helpers/state.py`
- Test: `python/tests/test_state.py`

**Interfaces:**
- Consumes: `self.session.gql.get_inventory()` — the same global call `_drops` already makes once per batch.
- Produces: NDJSON op `"inventory"`, no params, returning
  `{"inventory": {"<campaignId>": {"<dropId>": {"minutes": int, "claimed": bool, "instanceId": str|None}}}}`

Keyed by campaign then drop so the TypeScript join in Task 5 is two map lookups rather than a scan.

- [ ] **Step 1: Write the failing test**

```python
def inventory_drop(did="d1", watched=30, claimed=False, instance=None):
    return SimpleNamespace(
        id=did,
        self_edge=SimpleNamespace(
            current_minutes_watched=watched,
            is_claimed=claimed,
            drop_instance_id=instance,
        ),
    )


def test_inventory_keys_progress_by_campaign_and_drop():
    session = SimpleNamespace(
        gql=SimpleNamespace(
            get_inventory=lambda: SimpleNamespace(
                campaigns=[
                    SimpleNamespace(id="c1", time_based_drops=[
                        inventory_drop("d1", watched=30),
                        inventory_drop("d2", watched=60, instance="i9"),
                    ])
                ]
            )
        ),
        is_logged_in=lambda: True,
        reload_cookies=lambda: None,
    )
    out = Handler(session).handle({"id": 1, "op": "inventory"})
    assert out["ok"] is True
    assert out["data"]["inventory"]["c1"]["d1"]["minutes"] == 30
    assert out["data"]["inventory"]["c1"]["d2"]["instanceId"] == "i9"
    assert out["data"]["inventory"]["c1"]["d1"]["claimed"] is False


def test_inventory_empty_when_nothing_started():
    session = SimpleNamespace(
        gql=SimpleNamespace(
            get_inventory=lambda: SimpleNamespace(campaigns=None)
        ),
        is_logged_in=lambda: True,
        reload_cookies=lambda: None,
    )
    out = Handler(session).handle({"id": 1, "op": "inventory"})
    assert out["data"]["inventory"] == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pytest python/tests/test_state.py -k inventory -v`
Expected: FAIL — `unknown op: inventory`

- [ ] **Step 3: Write minimal implementation**

```python
    def _inventory(self) -> dict:
        """Global drop progress, keyed campaign id -> drop id.

        One call, covering every campaign we have started across all
        channels. Absence of a campaign here means it was never started
        -- but see the TypeScript side: a FAILED call must not be read
        the same way, or every drop falsely reads as not-started.
        """
        inventory = self.session.gql.get_inventory()
        out: dict = {}
        for campaign in getattr(inventory, "campaigns", None) or []:
            drops: dict = {}
            for drop in getattr(campaign, "time_based_drops", None) or []:
                edge = getattr(drop, "self_edge", None)
                if edge is None:
                    continue
                drops[getattr(drop, "id", None)] = {
                    "minutes": getattr(edge, "current_minutes_watched", 0) or 0,
                    "claimed": bool(getattr(edge, "is_claimed", False)),
                    "instanceId": getattr(edge, "drop_instance_id", None),
                }
            out[getattr(campaign, "id", None)] = drops
        return out
```

Dispatch after the `campaigns` branch:

```python
            if op == "inventory":
                self._ensure_token()
                return {"id": req_id, "ok": True,
                        "data": {"inventory": self._inventory()}}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pytest python/tests/test_state.py -k inventory -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add python/helpers/state.py python/tests/test_state.py
git commit -m "feat(helper): add an inventory op exposing global drop progress"
```

---

### Task 3: Campaign catalogue cache

**Files:**
- Create: `apps/backend/src/state/campaignCatalogue.ts`
- Test: `apps/backend/src/state/campaignCatalogue.test.ts`

**Interfaces:**
- Consumes: NDJSON op `"campaigns"` from Task 1, via `client.request<{campaigns: Campaign[]}>("campaigns")`.
- Produces:
  - `export const CATALOGUE_TTL_MS = 86_400_000`
  - `export const REFRESH_MIN_INTERVAL_MS = 60_000`
  - `export interface CampaignGame { id: string; slug: string; displayName: string }`
  - `export interface CampaignDrop { id: string; name: string; benefits: string[]; requiredMinutes: number; requiredSubs: number }`
  - `export interface Campaign { id: string; name: string; game: CampaignGame | null; startsAt: number | null; endsAt: number | null; allowChannelIds: string[]; drops: CampaignDrop[] }`
  - `export interface Catalogue { campaigns: Campaign[]; fetchedAt: number; stale: boolean }`
  - `export class CampaignCatalogue { constructor(deps: CatalogueDeps); get(): Promise<Catalogue>; refresh(): Promise<Catalogue> }`

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CampaignCatalogue,
  CATALOGUE_TTL_MS,
  REFRESH_MIN_INTERVAL_MS,
} from "./campaignCatalogue.js";

const campaign = (over: object = {}) => ({
  id: "c1", name: "Campaign One",
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1_000, endsAt: 9_000, allowChannelIds: [], drops: [], ...over,
});

let clock = 1_000_000;

function make(responses: unknown[]) {
  clock = 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const path = join(dir, "campaigns.json");
  const queue = [...responses];
  const request = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { campaigns: [] };
  });
  const cache = new CampaignCatalogue({
    client: { request } as never,
    path,
    now: () => clock,
  });
  return { cache, request, path };
}

test("fetches once and serves the cached list within the TTL", async () => {
  const { cache, request } = make([{ campaigns: [campaign()] }]);
  const first = await cache.get();
  clock += CATALOGUE_TTL_MS - 1;
  const second = await cache.get();
  expect(first.campaigns).toEqual([campaign()]);
  expect(second.campaigns).toEqual([campaign()]);
  expect(request).toHaveBeenCalledTimes(1);
});

test("refetches once the TTL has elapsed", async () => {
  const { cache, request } = make([
    { campaigns: [campaign()] },
    { campaigns: [campaign({ id: "c2" })] },
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
    { campaigns: [campaign()] },
    new Error("gql exploded"),
  ]);
  await cache.get();
  clock += CATALOGUE_TTL_MS + 1;
  const after = await cache.get();
  expect(after.campaigns).toEqual([campaign()]);
  expect(after.stale).toBe(true);
  expect(after.fetchedAt).toBe(1_000_000);
});

test("survives a restart by reloading from disk", async () => {
  const { cache, path } = make([{ campaigns: [campaign()] }]);
  await cache.get();
  // Campaign metadata stays true across a restart, unlike progress --
  // which is why this one is persisted and inventory is not.
  const revived = new CampaignCatalogue({
    client: { request: vi.fn(async () => ({ campaigns: [] })) } as never,
    path,
    now: () => clock,
  });
  const out = await revived.get();
  expect(out.campaigns).toEqual([campaign()]);
});

test("refresh bypasses the TTL", async () => {
  const { cache, request } = make([
    { campaigns: [campaign()] },
    { campaigns: [campaign({ id: "c2" })] },
  ]);
  await cache.get();
  clock += REFRESH_MIN_INTERVAL_MS + 1;
  const out = await cache.refresh();
  expect(out.campaigns[0]?.id).toBe("c2");
  expect(request).toHaveBeenCalledTimes(2);
});

test("refresh is rate limited so a double click costs one sweep", async () => {
  const { cache, request } = make([
    { campaigns: [campaign()] },
    { campaigns: [campaign({ id: "c2" })] },
  ]);
  await cache.refresh();
  const second = await cache.refresh();
  expect(request).toHaveBeenCalledTimes(1);
  expect(second.campaigns[0]?.id).toBe("c1");
});

test("a corrupt cache file is ignored rather than fatal", async () => {
  const { cache, path } = make([{ campaigns: [campaign()] }]);
  writeFileSync(path, "{ not json");
  const out = await cache.get();
  expect(out.campaigns).toEqual([campaign()]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/backend test campaignCatalogue`
Expected: FAIL — cannot resolve `./campaignCatalogue.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
import { readFileSync, writeFileSync } from "node:fs";

/**
 * How long the campaign catalogue is trusted.
 *
 * Twenty-four hours, three clocks away from the drops progress cache.
 * Campaigns are announced days ahead and run for weeks, and a drop's
 * requiredMinutes never changes once published -- so the list is nearly
 * static. The TTL exists to bound cost, not staleness: there can be 100+
 * active campaigns and fetching details for all of them per page load
 * would hammer the account the user is willing to lose.
 */
export const CATALOGUE_TTL_MS = 86_400_000;

/** Floor between manual refreshes, so a double click costs one sweep. */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

export interface CampaignGame {
  id: string;
  slug: string;
  displayName: string;
}

export interface CampaignDrop {
  id: string;
  name: string;
  benefits: string[];
  requiredMinutes: number;
  /** Non-zero means it can never be earned by watching -- see dropState. */
  requiredSubs: number;
}

export interface Campaign {
  id: string;
  name: string;
  game: CampaignGame | null;
  startsAt: number | null;
  endsAt: number | null;
  /** Empty for an open campaign; non-empty restricts it to these channels. */
  allowChannelIds: string[];
  drops: CampaignDrop[];
}

export interface Catalogue {
  campaigns: Campaign[];
  /** Epoch ms of the fetch these campaigns came from. */
  fetchedAt: number;
  /** True when the TTL has lapsed and the refetch failed. */
  stale: boolean;
}

export interface CatalogueDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
  /** Where the catalogue is persisted across restarts. */
  path: string;
  now?: () => number;
}

interface Persisted {
  campaigns: Campaign[];
  fetchedAt: number;
}

/**
 * The campaign catalogue, on a 24h clock and backed by disk.
 *
 * Persisted deliberately, unlike DropsCache: every field here stays true
 * across a restart, so reloading it is honest. Progress does not have
 * that property, which is why inventory.ts holds its data in memory only.
 *
 * Never rejects on a refetch failure -- it serves what it has and says
 * how old it is.
 */
export class CampaignCatalogue {
  private campaigns: Campaign[] | null = null;
  private fetchedAt = 0;
  private lastRefreshAt = 0;
  private stale = false;
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: CatalogueDeps) {
    this.load();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private load(): void {
    try {
      const raw = JSON.parse(
        readFileSync(this.deps.path, "utf8"),
      ) as Persisted;
      if (Array.isArray(raw.campaigns)) {
        this.campaigns = raw.campaigns;
        this.fetchedAt = raw.fetchedAt ?? 0;
      }
    } catch {
      // No file yet, or an unparseable one. Either way the catalogue
      // starts empty and the next get() fetches -- a corrupt cache must
      // not stop the process booting.
    }
  }

  private persist(): void {
    try {
      const body: Persisted = {
        campaigns: this.campaigns ?? [],
        fetchedAt: this.fetchedAt,
      };
      writeFileSync(this.deps.path, JSON.stringify(body));
    } catch {
      // A read-only or full disk costs the restart optimisation, not the
      // feature -- the in-memory copy is still serving.
    }
  }

  private snapshot(): Catalogue {
    return {
      campaigns: this.campaigns ?? [],
      fetchedAt: this.fetchedAt,
      stale: this.stale,
    };
  }

  private async fetch(): Promise<void> {
    // Collapse concurrent callers onto one request: two page loads must
    // not each trigger a 100-campaign detail sweep.
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await this.deps.client.request<{ campaigns: Campaign[] }>(
          "campaigns",
        );
        this.campaigns = res.campaigns ?? [];
        this.fetchedAt = this.now();
        this.stale = false;
        this.persist();
      } catch {
        // Keep what we have and mark it. The page shows the age.
        this.stale = this.campaigns !== null;
        if (this.campaigns === null) this.campaigns = [];
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async get(): Promise<Catalogue> {
    const fresh =
      this.campaigns !== null &&
      this.now() - this.fetchedAt < CATALOGUE_TTL_MS;
    if (!fresh) await this.fetch();
    return this.snapshot();
  }

  async refresh(): Promise<Catalogue> {
    const at = this.now();
    if (at - this.lastRefreshAt < REFRESH_MIN_INTERVAL_MS) {
      return this.snapshot();
    }
    this.lastRefreshAt = at;
    await this.fetch();
    return this.snapshot();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/backend test campaignCatalogue`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/state/campaignCatalogue.ts apps/backend/src/state/campaignCatalogue.test.ts
git commit -m "feat(drops): cache the campaign catalogue on a 24h disk-backed clock"
```

---

### Task 4: Inventory progress cache

**Files:**
- Create: `apps/backend/src/state/inventory.ts`
- Test: `apps/backend/src/state/inventory.test.ts`

**Interfaces:**
- Consumes: NDJSON op `"inventory"` from Task 2.
- Produces:
  - `export const INVENTORY_TTL_MS = 600_000`
  - `export interface DropProgressEntry { minutes: number; claimed: boolean; instanceId: string | null }`
  - `export type InventoryMap = Record<string, Record<string, DropProgressEntry>>`
  - `export interface InventorySnapshot { progress: InventoryMap; fetchedAt: number; available: boolean }`
  - `export class InventoryCache { constructor(deps: InventoryDeps); get(): Promise<InventorySnapshot> }`

`available: false` is the load-bearing field — it is how Task 5 distinguishes "never started" from "we could not find out".

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test, vi } from "vitest";
import { InventoryCache, INVENTORY_TTL_MS } from "./inventory.js";

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
  expect(out.progress.c1?.d1).toEqual(progress);
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
  expect(out.progress.c1?.d1).toEqual(progress);
  expect(request).toHaveBeenCalledTimes(2);
});

test("a failed fetch reports unavailable rather than empty progress", async () => {
  // The distinction that matters: absent-from-inventory means "never
  // started", but a FAILED fetch means "unknown". Reading the second as
  // the first would fill the page with confident zeros.
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
  expect(out.progress.c1?.d1).toEqual(progress);
  expect(out.available).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/backend test inventory`
Expected: FAIL — cannot resolve `./inventory.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * How long fetched drop progress is trusted.
 *
 * Ten minutes, matching DROPS_TTL_MS and for the same reason: progress
 * moves in 30/60/120-minute steps, so ten minutes is invisible in the UI
 * while keeping the call count sane.
 */
export const INVENTORY_TTL_MS = 600_000;

export interface DropProgressEntry {
  minutes: number;
  claimed: boolean;
  /** Set once Twitch mints an instance -- the drop is sitting there. */
  instanceId: string | null;
}

/** campaign id -> drop id -> progress. */
export type InventoryMap = Record<string, Record<string, DropProgressEntry>>;

export interface InventorySnapshot {
  progress: InventoryMap;
  fetchedAt: number;
  /**
   * Whether the progress above can be trusted as complete.
   *
   * False after a failed fetch. Callers MUST NOT read an absent drop as
   * "not started" when this is false -- see dropState.ts.
   */
  available: boolean;
}

export interface InventoryDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
  now?: () => number;
}

/**
 * Global drop progress, on the same slow clock as DropsCache.
 *
 * Held in memory only, never persisted. Progress is a live figure whose
 * whole value is being current; reloaded from disk after a restart it
 * would describe whatever was true when the process last ran. The
 * campaign catalogue beside it makes the opposite call, deliberately.
 */
export class InventoryCache {
  private progress: InventoryMap = {};
  private fetchedAt = 0;
  private available = false;
  private everFetched = false;
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: InventoryDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async fetch(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await this.deps.client.request<{
          inventory: InventoryMap;
        }>("inventory");
        this.progress = res.inventory ?? {};
        this.fetchedAt = this.now();
        this.available = true;
        this.everFetched = true;
      } catch {
        // Keep the last known progress if we had any -- a stale bar is
        // better than a vanished one -- but stop claiming it is complete.
        this.available = false;
        if (!this.everFetched) this.progress = {};
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async get(): Promise<InventorySnapshot> {
    const fresh =
      this.everFetched && this.now() - this.fetchedAt < INVENTORY_TTL_MS;
    if (!fresh) await this.fetch();
    return {
      progress: this.progress,
      fetchedAt: this.fetchedAt,
      available: this.available,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/backend test inventory`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/state/inventory.ts apps/backend/src/state/inventory.test.ts
git commit -m "feat(drops): cache global inventory progress in memory"
```

---

### Task 5: Drop state join (pure)

**Files:**
- Create: `apps/backend/src/state/dropState.ts`
- Test: `apps/backend/src/state/dropState.test.ts`

**Interfaces:**
- Consumes: `Campaign`, `CampaignDrop` from Task 3; `InventorySnapshot` from Task 4.
- Produces:
  - `export type DropStatus = "unobtainable" | "claimed" | "claimable" | "in-progress" | "not-started" | "unknown"`
  - `export type CampaignStatus = "collected" | "partial" | "untouched" | "unknown"`
  - `export interface ResolvedDrop { id: string; name: string; benefits: string[]; requiredMinutes: number; minutes: number; status: DropStatus }`
  - `export interface ResolvedCampaign extends Campaign { drops: ResolvedDrop[]; status: CampaignStatus }`
  - `export function resolveDrop(drop: CampaignDrop, entry: DropProgressEntry | undefined, available: boolean): ResolvedDrop`
  - `export function resolveCampaign(campaign: Campaign, inv: InventorySnapshot): ResolvedCampaign`

Pure — no clock, no network, no I/O. This is the module the six-state table lives in.

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "vitest";
import { resolveCampaign, resolveDrop } from "./dropState.js";
import type { Campaign, CampaignDrop } from "./campaignCatalogue.js";

const drop = (over: Partial<CampaignDrop> = {}): CampaignDrop => ({
  id: "d1", name: "Crate", benefits: ["Crate"],
  requiredMinutes: 60, requiredSubs: 0, ...over,
});

const campaign = (drops: CampaignDrop[]): Campaign => ({
  id: "c1", name: "Campaign One",
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1_000, endsAt: 9_000, allowChannelIds: [], drops,
});

const snapshot = (progress: object, available = true) => ({
  progress, fetchedAt: 1_000, available,
}) as never;

test("a sub-gated drop is unobtainable whatever its progress", () => {
  // Drop.update sets is_claimable False whenever subs_required > 0, so
  // watching can never finish it. Showing it as merely "not started"
  // means "collect all drops" silently never completes.
  const out = resolveDrop(drop({ requiredSubs: 1 }), undefined, true);
  expect(out.status).toBe("unobtainable");
});

test("unobtainable wins even over recorded progress", () => {
  const out = resolveDrop(
    drop({ requiredSubs: 1 }),
    { minutes: 30, claimed: false, instanceId: null },
    true,
  );
  expect(out.status).toBe("unobtainable");
});

test("a claimed drop reports claimed", () => {
  const out = resolveDrop(
    drop(), { minutes: 60, claimed: true, instanceId: "i1" }, true,
  );
  expect(out.status).toBe("claimed");
});

test("an instance minted but unclaimed is claimable", () => {
  const out = resolveDrop(
    drop(), { minutes: 60, claimed: false, instanceId: "i1" }, true,
  );
  expect(out.status).toBe("claimable");
});

test("partial minutes report in-progress", () => {
  const out = resolveDrop(
    drop(), { minutes: 30, claimed: false, instanceId: null }, true,
  );
  expect(out.status).toBe("in-progress");
  expect(out.minutes).toBe(30);
});

test("absent from an available inventory means not started", () => {
  const out = resolveDrop(drop(), undefined, true);
  expect(out.status).toBe("not-started");
  expect(out.minutes).toBe(0);
});

test("absent from an UNAVAILABLE inventory means unknown, not zero", () => {
  // The whole reason InventorySnapshot carries `available`: a failed
  // fetch makes every drop absent, and reading that as not-started
  // would fill the page with confident zeros.
  const out = resolveDrop(drop(), undefined, false);
  expect(out.status).toBe("unknown");
});

test("minutes are clamped to the requirement", () => {
  // Twitch keeps counting past the requirement; a bar reading 71/60
  // reads as a bug rather than a finished drop.
  const out = resolveDrop(
    drop(), { minutes: 71, claimed: false, instanceId: null }, true,
  );
  expect(out.minutes).toBe(60);
});

test("a campaign whose obtainable drops are all claimed is collected", () => {
  const out = resolveCampaign(
    campaign([drop({ id: "d1" }), drop({ id: "d2", requiredSubs: 1 })]),
    snapshot({ c1: { d1: { minutes: 60, claimed: true, instanceId: "i" } } }),
  );
  // The sub-gated drop is excluded from the verdict -- it can never be
  // collected, so counting it would make the campaign permanently partial.
  expect(out.status).toBe("collected");
});

test("a campaign with some progress is partial", () => {
  const out = resolveCampaign(
    campaign([drop({ id: "d1" }), drop({ id: "d2" })]),
    snapshot({ c1: { d1: { minutes: 60, claimed: true, instanceId: "i" } } }),
  );
  expect(out.status).toBe("partial");
});

test("a campaign with no progress is untouched", () => {
  const out = resolveCampaign(campaign([drop()]), snapshot({}));
  expect(out.status).toBe("untouched");
});

test("a campaign is unknown when the inventory is unavailable", () => {
  const out = resolveCampaign(campaign([drop()]), snapshot({}, false));
  expect(out.status).toBe("unknown");
});

test("a campaign of only sub-gated drops is unobtainable, not collected", () => {
  const out = resolveCampaign(
    campaign([drop({ requiredSubs: 1 })]), snapshot({}),
  );
  expect(out.status).toBe("untouched");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/backend test dropState`
Expected: FAIL — cannot resolve `./dropState.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { Campaign, CampaignDrop } from "./campaignCatalogue.js";
import type { DropProgressEntry, InventorySnapshot } from "./inventory.js";

/**
 * What a single drop is doing for this viewer.
 *
 * `unknown` is not a failure mode to be tidied away -- it is the honest
 * answer when the inventory could not be read, and it is what stops the
 * page rendering a wall of zeroes that look like real facts.
 */
export type DropStatus =
  | "unobtainable"
  | "claimed"
  | "claimable"
  | "in-progress"
  | "not-started"
  | "unknown";

export type CampaignStatus = "collected" | "partial" | "untouched" | "unknown";

export interface ResolvedDrop {
  id: string;
  name: string;
  benefits: string[];
  requiredMinutes: number;
  /** Clamped to requiredMinutes; 0 when not started or unknown. */
  minutes: number;
  status: DropStatus;
}

export interface ResolvedCampaign extends Omit<Campaign, "drops"> {
  drops: ResolvedDrop[];
  status: CampaignStatus;
}

/**
 * One drop's state, from its definition plus whatever the inventory knows.
 *
 * Order matters. `unobtainable` is tested first because a sub-gated drop
 * can never be earned by watching however much progress exists against
 * it, and `unknown` is tested before `not-started` because an absent
 * entry means two different things depending on whether the fetch worked.
 */
export function resolveDrop(
  drop: CampaignDrop,
  entry: DropProgressEntry | undefined,
  available: boolean,
): ResolvedDrop {
  const base = {
    id: drop.id,
    name: drop.name,
    benefits: drop.benefits,
    requiredMinutes: drop.requiredMinutes,
  };
  if (drop.requiredSubs > 0) {
    return { ...base, minutes: 0, status: "unobtainable" };
  }
  if (entry === undefined) {
    return {
      ...base,
      minutes: 0,
      status: available ? "not-started" : "unknown",
    };
  }
  // Clamped: Twitch keeps counting past the requirement, and a bar
  // reporting 71/60 reads as a bug rather than a finished drop.
  const minutes = Math.min(entry.minutes, drop.requiredMinutes);
  if (entry.claimed) return { ...base, minutes, status: "claimed" };
  if (entry.instanceId !== null) {
    return { ...base, minutes, status: "claimable" };
  }
  return {
    ...base,
    minutes,
    status: minutes > 0 ? "in-progress" : "not-started",
  };
}

/**
 * A campaign's drops resolved, plus the one-word verdict the list shows.
 *
 * Sub-gated drops are excluded from the verdict: they can never be
 * collected, so counting them would leave such a campaign permanently
 * "partial" no matter what the viewer does.
 */
export function resolveCampaign(
  campaign: Campaign,
  inv: InventorySnapshot,
): ResolvedCampaign {
  const entries = inv.progress[campaign.id] ?? {};
  const drops = campaign.drops.map((d) =>
    resolveDrop(d, entries[d.id], inv.available),
  );
  return { ...campaign, drops, status: campaignStatus(drops, inv.available) };
}

function campaignStatus(
  drops: ResolvedDrop[],
  available: boolean,
): CampaignStatus {
  if (!available) return "unknown";
  const obtainable = drops.filter((d) => d.status !== "unobtainable");
  if (obtainable.length === 0) return "untouched";
  if (obtainable.every((d) => d.status === "claimed")) return "collected";
  const touched = obtainable.some((d) => d.status !== "not-started");
  return touched ? "partial" : "untouched";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/backend test dropState`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/state/dropState.ts apps/backend/src/state/dropState.test.ts
git commit -m "feat(drops): resolve per-drop and per-campaign collection state"
```

---

### Task 6: Campaign routes

**Files:**
- Modify: `apps/backend/src/http/server.ts`
- Modify: `apps/backend/src/index.ts` (construct both caches, pass into the server)
- Test: `apps/backend/src/http/server.test.ts`

**Interfaces:**
- Consumes: `CampaignCatalogue` (Task 3), `InventoryCache` (Task 4), `resolveCampaign` (Task 5).
- Produces:
  - `GET /api/campaigns` → `{ campaigns: ResolvedCampaign[], catalogueFetchedAt: number, catalogueStale: boolean, progressFetchedAt: number, progressAvailable: boolean }`
  - `POST /api/campaigns/refresh` → the same body, after a TTL-bypassing refresh.
  - Server deps gain `catalogue: CampaignCatalogue` and `inventory: InventoryCache`.

Both ages are returned separately and deliberately: a three-minute-old progress bar under a twenty-hour-old campaign list is correct, but one combined "updated N ago" reads as a bug.

- [ ] **Step 1: Write the failing test**

Follow the existing harness in `server.test.ts` for building an app with fake deps; add:

```typescript
test("GET /api/campaigns joins catalogue and progress", async () => {
  const app = await buildTestApp({
    catalogue: {
      get: async () => ({
        campaigns: [{
          id: "c1", name: "One",
          game: { id: "g1", slug: "a-game", displayName: "A Game" },
          startsAt: 1, endsAt: 2, allowChannelIds: [],
          drops: [{ id: "d1", name: "Crate", benefits: ["Crate"],
                    requiredMinutes: 60, requiredSubs: 0 }],
        }],
        fetchedAt: 111, stale: false,
      }),
      refresh: async () => { throw new Error("not used here"); },
    },
    inventory: {
      get: async () => ({
        progress: { c1: { d1: { minutes: 30, claimed: false, instanceId: null } } },
        fetchedAt: 222, available: true,
      }),
    },
  });
  const res = await app.inject({ method: "GET", url: "/api/campaigns" });
  const body = res.json();
  expect(res.statusCode).toBe(200);
  expect(body.campaigns[0].drops[0].status).toBe("in-progress");
  // Two clocks, reported separately -- one merged age would be a lie.
  expect(body.catalogueFetchedAt).toBe(111);
  expect(body.progressFetchedAt).toBe(222);
});

test("POST /api/campaigns/refresh bypasses the TTL", async () => {
  const refresh = vi.fn(async () => ({
    campaigns: [], fetchedAt: 999, stale: false,
  }));
  const app = await buildTestApp({
    catalogue: { get: async () => ({ campaigns: [], fetchedAt: 1, stale: false }), refresh },
    inventory: { get: async () => ({ progress: {}, fetchedAt: 2, available: true }) },
  });
  const res = await app.inject({ method: "POST", url: "/api/campaigns/refresh" });
  expect(res.statusCode).toBe(200);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(res.json().catalogueFetchedAt).toBe(999);
});

test("campaign routes require a session", async () => {
  const app = await buildTestApp({});
  const res = await app.inject({ method: "GET", url: "/api/campaigns" });
  expect(res.statusCode).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/backend test server`
Expected: FAIL — 404 on both routes

- [ ] **Step 3: Write minimal implementation**

In `server.ts`, alongside the other authenticated `/api` routes (match the existing auth guard those routes use):

```typescript
  /**
   * The Drops page's whole payload: the campaign catalogue joined with
   * this viewer's progress.
   *
   * The two ages are reported separately on purpose. They are on clocks
   * a day apart, and collapsing them into one "updated N ago" would
   * describe neither.
   */
  async function campaignPayload(refresh: boolean) {
    const cat = refresh
      ? await deps.catalogue.refresh()
      : await deps.catalogue.get();
    const inv = await deps.inventory.get();
    return {
      campaigns: cat.campaigns.map((c) => resolveCampaign(c, inv)),
      catalogueFetchedAt: cat.fetchedAt,
      catalogueStale: cat.stale,
      progressFetchedAt: inv.fetchedAt,
      progressAvailable: inv.available,
    };
  }

  app.get("/api/campaigns", async () => campaignPayload(false));
  app.post("/api/campaigns/refresh", async () => campaignPayload(true));
```

Import `resolveCampaign` from `../state/dropState.js`, and add `catalogue` / `inventory` to the server's deps interface. In `index.ts`, construct both with the existing helper client and a catalogue path beside the other app data files.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/backend test server`
Expected: PASS

- [ ] **Step 5: Run the full backend suite**

Run: `cd /workspace && pnpm --filter @app/backend test`
Expected: PASS, no regressions

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/http/server.ts apps/backend/src/http/server.test.ts apps/backend/src/index.ts
git commit -m "feat(api): serve drop campaigns joined with viewer progress"
```

---

### Task 7: Drop and campaign components

**Files:**
- Create: `apps/frontend/src/components/DropRow.tsx`
- Create: `apps/frontend/src/components/CampaignCard.tsx`
- Test: `apps/frontend/src/components/DropRow.test.tsx`

**Interfaces:**
- Consumes: `ResolvedDrop`, `ResolvedCampaign`, `DropStatus` from Task 5's types.
- Produces: `<DropRow drop={ResolvedDrop} />`, `<CampaignCard campaign={ResolvedCampaign} />`.

Match the existing component conventions in `apps/frontend/src/components/` — read `StreamerCard.tsx` and `Gain.tsx` first for the em-dash/null idiom and Mantine usage.

- [ ] **Step 1: Write the failing test**

```tsx
import { expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { DropRow } from "./DropRow.js";
import { renderApp } from "../test-utils.js";

// renderApp, not a bare render: a bare <MantineProvider> uses Mantine's
// default theme and would assert against a theme the app never ships.
const render = renderApp;

const drop = (over: object = {}) => ({
  id: "d1", name: "Crate", benefits: ["Crate"],
  requiredMinutes: 60, minutes: 30, status: "in-progress", ...over,
}) as never;

test("shows minutes watched against the requirement", () => {
  render(<DropRow drop={drop()} />);
  expect(screen.getByText(/30\s*\/\s*60/)).toBeTruthy();
});

test("a claimed drop says so and shows no progress bar", () => {
  render(<DropRow drop={drop({ status: "claimed", minutes: 60 })} />);
  expect(screen.getByText(/claimed/i)).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("a claimable drop is called out as ready", () => {
  render(<DropRow drop={drop({ status: "claimable", minutes: 60 })} />);
  expect(screen.getByText(/ready/i)).toBeTruthy();
});

test("a sub-gated drop is marked unobtainable with a reason", () => {
  render(<DropRow drop={drop({ status: "unobtainable" })} />);
  expect(screen.getByText(/subscription/i)).toBeTruthy();
});

test("an unknown drop shows an em-dash, never a zero bar", () => {
  // "Nothing earned" and "nothing known" are different claims -- the
  // same distinction Gain.tsx:30 draws for balances.
  render(<DropRow drop={drop({ status: "unknown", minutes: 0 })} />);
  expect(screen.getByText("—")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("a not-started drop shows the requirement without progress", () => {
  render(<DropRow drop={drop({ status: "not-started", minutes: 0 })} />);
  expect(screen.getByText(/60/)).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/frontend test DropRow`
Expected: FAIL — cannot resolve `./DropRow.js`

- [ ] **Step 3: Write minimal implementation**

`DropRow.tsx` renders name, benefits, and a status-dependent right-hand side:

- `in-progress` → Mantine `Progress` plus `{minutes} / {requiredMinutes}`
- `claimed` → a muted "Claimed" badge, no bar
- `claimable` → a highlighted "Ready to claim" badge, no bar
- `unobtainable` → "Needs a subscription" badge, no bar, muted row
- `not-started` → `{requiredMinutes} min` text, no bar
- `unknown` → `—`, no bar

`CampaignCard.tsx` renders the campaign name, game, end date (24-hour dial per the existing house convention — see the `f437014` commit), a status badge from `campaign.status`, and its drops as `DropRow`s in a collapsible section.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/frontend test DropRow`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/DropRow.tsx apps/frontend/src/components/CampaignCard.tsx apps/frontend/src/components/DropRow.test.tsx
git commit -m "feat(ui): render drop and campaign collection state"
```

---

### Task 8: The Drops page

**Files:**
- Create: `apps/frontend/src/routes/Drops.tsx`
- Test: `apps/frontend/src/routes/Drops.test.tsx`
- Modify: `apps/frontend/src/app.tsx` — add a `drops` entry to the `SCREENS` map (see `app.tsx:26` for the shape; `streamers: { label: "Streamers", element: () => <Streamers /> }` is the closest model)

**Interfaces:**
- Consumes: `GET /api/campaigns`, `POST /api/campaigns/refresh` (Task 6) via `api.get`/`api.post` from `../api/client.js`; `CampaignCard` (Task 7).
- Produces: a `drops` screen reachable from the main nav.

Filtering is client-side over the fetched list — with a few hundred campaigns a server round trip gains nothing and costs responsiveness.

**Note on testing Mantine here:** `Select`/`Combobox` do not hang under vitest, but their options render in a portal — query them with `{ hidden: true }`.

- [ ] **Step 1: Write the failing test**

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { Drops } from "./Drops.js";
import { renderApp } from "../test-utils.js";

const payload = {
  campaigns: [
    { id: "c1", name: "Alpha Campaign",
      game: { id: "g1", slug: "alpha-game", displayName: "Alpha Game" },
      startsAt: 1, endsAt: 2, allowChannelIds: [], drops: [], status: "untouched" },
    { id: "c2", name: "Beta Campaign",
      game: { id: "g2", slug: "beta-game", displayName: "Beta Game" },
      startsAt: 1, endsAt: 2, allowChannelIds: [], drops: [], status: "partial" },
  ],
  catalogueFetchedAt: 111, catalogueStale: false,
  progressFetchedAt: 222, progressAvailable: true,
};

let calls: Array<{ url: string; init?: RequestInit }>;
let body: typeof payload;

// Stubbed fetch, matching routes/Streamers.test.tsx -- this codebase
// tests screens through the network boundary, not through injected props.
beforeEach(() => {
  calls = [];
  body = payload;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body };
  }));
});

test("lists every campaign the server returns", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  expect(screen.getByText("Beta Campaign")).toBeTruthy();
});

test("filters by campaign name", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "Beta");
  expect(screen.queryByText("Alpha Campaign")).toBeNull();
  expect(screen.getByText("Beta Campaign")).toBeTruthy();
});

test("shows both cache ages separately", async () => {
  // Two clocks a day apart -- one merged "updated N ago" would describe
  // neither, so they render as separate elements.
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  expect(screen.getByTestId("catalogue-age")).toBeTruthy();
  expect(screen.getByTestId("progress-age")).toBeTruthy();
});

test("warns when progress could not be read", async () => {
  body = { ...payload, progressAvailable: false };
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByText(/progress.*unavailable/i)).toBeTruthy());
});

test("refresh posts to the refresh route", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
  await waitFor(() =>
    expect(calls.some((c) => c.url === "/api/campaigns/refresh")).toBe(true));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/frontend test Drops`
Expected: FAIL — cannot resolve `./Drops.js`

- [ ] **Step 3: Write minimal implementation**

`Drops.tsx` takes no props. It fetches `GET /api/campaigns` on mount with `api.get` and holds the payload in local state, as the other routes do, and renders:

- a text input labelled "Filter" matching campaign name, case-insensitively
- a game `Select` built from the distinct games present
- both cache ages, in separate elements with `data-testid="catalogue-age"` and `"progress-age"`
- a "Refresh" button calling `refreshCampaigns`
- a warning banner when `progressAvailable` is false
- a stale notice when `catalogueStale` is true
- the filtered campaigns as `CampaignCard`s

Then add `drops: { label: "Drops", element: () => <Drops /> }` to the `SCREENS` map in `app.tsx`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/frontend test Drops`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full suite**

Run: `cd /workspace && pnpm test`
Expected: PASS across backend, frontend and Python

- [ ] **Step 6: Verify in the real app**

Run the app and open `/drops`. Confirm campaigns list, filters work, and both ages render. Screenshot it for the review.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src
git commit -m "feat(ui): add a Drops page listing campaigns with progress"
```

**Phase 1 is complete and shippable here.**

---

# PHASE 2 — The Subscription Engine

> **Deviations, recorded 2026-09-17 after implementing Tasks 9-13.**
> The plan was written before the campaign source moved off Twitch, and
> three of its assumptions no longer hold.
>
> **`allowChannelIds` is gone.** Twitch's campaign API carries a channel
> allowlist; the public tracker the catalogue now reads does not. Task
> 12's two-path resolution (allowlist, else directory) collapses to one,
> and the directory is the single point of failure rather than a
> fallback. Removed from the codebase in its own commit before Task 9.
>
> **The directory query is confirmed reachable**, so Task 12's framing of
> it as "the design's load-bearing risk" overstates it: `DirectoryPage_Game`
> answers normally and `systemFilters: ["DROPS_ENABLED"]` makes Twitch do
> the drops filtering server-side. The hash is still ours to maintain and
> will rotate eventually, which is what `degraded` exists for. Matching
> the stream's tags instead is NOT viable -- the drops tag is localised
> per channel ("DropsAktiviert", "DropyZapnute").
>
> **Game subscriptions resolve without a campaign.** The plan treated
> every subscription as campaign-backed; a game subscription is not tied
> to one campaign's lifetime, so it neither needs a catalogue entry nor
> is ever ended by one going missing.
>
> Also: `PendingRestart`'s public method is `fireNow()`, not `now()`, so
> it cannot collide with the private clock helper every cache here calls
> `now()`. And Task 9's fixtures in this plan omit `enabled`/`settings`,
> which the real streamer schema requires and marks `.strict()`.
>
> **Tasks 14-15 are not implemented.** The engine is complete and tested
> but nothing constructs it: there are no subscription routes, no UI, and
> `index.ts` does not build a `SubscriptionEngine`. It is unreachable
> code until those land.


### Task 9: Config schema for subscriptions

**Files:**
- Modify: `apps/backend/src/config/schema.ts`
- Test: `apps/backend/src/config/store.test.ts`
- Modify: `python/miner_config.py` and `python/tests/test_schema_parity.py` if the parity test covers streamer keys (check first: `pytest python/tests/test_schema_parity.py -v`)

**Interfaces:**
- Produces:
  - `export const subscriptionSchema` → `{ id: string; kind: "campaign" | "game"; targetId: string; label: string; poolSize: number (1-10, default 3); rank: number }`
  - `AppConfig.subscriptions: Subscription[]` (defaults to `[]`)
  - Streamer entries gain optional `ownedBy?: string` — the subscription id that added them.

`ownedBy` is what makes a temporary entry identifiable, and the whole reconciliation diff depends on it.

- [ ] **Step 1: Write the failing test**

```typescript
test("defaults subscriptions to an empty list", () => {
  const config = configSchema.parse({ ...minimalConfig });
  expect(config.subscriptions).toEqual([]);
});

test("accepts a campaign subscription with a default pool size", () => {
  const config = configSchema.parse({
    ...minimalConfig,
    subscriptions: [{ id: "s1", kind: "campaign", targetId: "c1",
                      label: "Alpha Campaign", rank: 0 }],
  });
  expect(config.subscriptions[0]?.poolSize).toBe(3);
});

test("rejects a pool size outside 1-10", () => {
  expect(() => configSchema.parse({
    ...minimalConfig,
    subscriptions: [{ id: "s1", kind: "campaign", targetId: "c1",
                      label: "x", rank: 0, poolSize: 99 }],
  })).toThrow();
});

test("a streamer entry may record the subscription that added it", () => {
  const config = configSchema.parse({
    ...minimalConfig,
    streamers: [{ username: "alpha", ownedBy: "s1" }],
  });
  expect(config.streamers[0]?.ownedBy).toBe("s1");
});

test("a hand-added streamer has no owner", () => {
  const config = configSchema.parse({
    ...minimalConfig,
    streamers: [{ username: "alpha" }],
  });
  expect(config.streamers[0]?.ownedBy).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/backend test store`
Expected: FAIL — `subscriptions` is undefined, `ownedBy` is stripped

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * One standing instruction to collect a campaign's drops.
 *
 * Stores intent, never channels. The channels it currently resolves to
 * live in `streamers` marked with `ownedBy`, and are rewritten by the
 * engine whenever resolution produces a different set.
 */
export const subscriptionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["campaign", "game"]),
  /** A campaign id, or a game id, per `kind`. */
  targetId: z.string().min(1),
  /** Display name, cached so the UI reads right when the catalogue is cold. */
  label: z.string().min(1),
  /**
   * How many channels to keep in the config for this subscription.
   *
   * Three by default: enough that one channel ending its stream is
   * absorbed by the miner's own selector without a restart, few enough
   * that several subscriptions do not crowd out the roster.
   */
  poolSize: z.number().int().min(1).max(10).default(3),
  /** Lower ranks fill the miner's watch slots first. */
  rank: z.number().int().min(0),
});

export type Subscription = z.infer<typeof subscriptionSchema>;
```

Add `subscriptions: z.array(subscriptionSchema).default([])` to the config object, and `ownedBy: z.string().optional()` to the streamer entry schema.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/backend test store`
Expected: PASS

- [ ] **Step 5: Check Python parity**

Run: `cd /workspace && pytest python/tests/test_schema_parity.py -v`
Expected: PASS. If it fails because it enumerates streamer keys, add `ownedBy` to the ignore list there — it is an app-side field the miner never sees, and `miner_config.py` must not forward it.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/config/schema.ts apps/backend/src/config/store.test.ts python/
git commit -m "feat(config): add drop subscriptions and subscription-owned streamers"
```

---

### Task 10: Reconciliation (pure)

**Files:**
- Create: `apps/backend/src/drops/reconcile.ts`
- Test: `apps/backend/src/drops/reconcile.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, `Subscription` (Task 9).
- Produces:
  - `export interface DesiredEntry { username: string; ownedBy: string }`
  - `export interface Reconciliation { streamers: AppConfig["streamers"]; changed: boolean }`
  - `export function reconcile(current: AppConfig["streamers"], desired: DesiredEntry[]): Reconciliation`

**Pure: no clock, no network, no I/O.** This is where restart bugs would otherwise breed, so it is exhaustively tested against fixtures. `changed` is the restart verdict — the engine restarts if and only if it is true.

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test } from "vitest";
import { reconcile } from "./reconcile.js";

const owned = (username: string, ownedBy: string) => ({ username, ownedBy });
const manual = (username: string) => ({ username });

test("no change when the desired set already matches", () => {
  const out = reconcile([manual("alpha"), owned("beta", "s1")],
                        [{ username: "beta", ownedBy: "s1" }]);
  expect(out.changed).toBe(false);
});

test("adds a newly resolved channel", () => {
  const out = reconcile([manual("alpha")],
                        [{ username: "beta", ownedBy: "s1" }]);
  expect(out.changed).toBe(true);
  expect(out.streamers.map((s) => s.username)).toEqual(["alpha", "beta"]);
});

test("removes a channel whose subscription no longer wants it", () => {
  const out = reconcile([manual("alpha"), owned("beta", "s1")], []);
  expect(out.changed).toBe(true);
  expect(out.streamers.map((s) => s.username)).toEqual(["alpha"]);
});

test("never touches hand-added streamers", () => {
  // The user's own roster is theirs. The engine owns only what it added.
  const out = reconcile([manual("alpha"), manual("gamma")], []);
  expect(out.changed).toBe(false);
  expect(out.streamers.map((s) => s.username)).toEqual(["alpha", "gamma"]);
});

test("reordering the desired pool is a change", () => {
  // Order is what upstream's priority_order consumes, so it is a real
  // difference in what the miner will watch first.
  const out = reconcile(
    [owned("beta", "s1"), owned("gamma", "s1")],
    [{ username: "gamma", ownedBy: "s1" }, { username: "beta", ownedBy: "s1" }],
  );
  expect(out.changed).toBe(true);
  expect(out.streamers.map((s) => s.username)).toEqual(["gamma", "beta"]);
});

test("a channel the user already follows is not duplicated", () => {
  // It stays manual: the user's entry wins and keeps its own settings.
  const out = reconcile([manual("beta")],
                        [{ username: "beta", ownedBy: "s1" }]);
  expect(out.changed).toBe(false);
  expect(out.streamers).toHaveLength(1);
  expect(out.streamers[0]?.ownedBy).toBeUndefined();
});

test("ownership transfers when a different subscription claims a channel", () => {
  const out = reconcile([owned("beta", "s1")],
                        [{ username: "beta", ownedBy: "s2" }]);
  expect(out.changed).toBe(true);
  expect(out.streamers[0]?.ownedBy).toBe("s2");
});

test("owned entries sort after manual ones", () => {
  const out = reconcile([manual("alpha")],
                        [{ username: "beta", ownedBy: "s1" }]);
  expect(out.streamers[0]?.username).toBe("alpha");
});

test("username comparison is case-insensitive", () => {
  const out = reconcile([owned("Beta", "s1")],
                        [{ username: "beta", ownedBy: "s1" }]);
  expect(out.changed).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/backend test reconcile`
Expected: FAIL — cannot resolve `./reconcile.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { AppConfig } from "../config/schema.js";
import { normaliseUsername } from "../state/roster.js";

/** One channel a subscription wants in the config. */
export interface DesiredEntry {
  username: string;
  /** The subscription id that resolved it. */
  ownedBy: string;
}

export interface Reconciliation {
  streamers: AppConfig["streamers"];
  /**
   * Whether the config actually differs. This is the restart verdict:
   * the engine restarts the miner if and only if this is true, so a pass
   * that resolves the same channels as last time costs nothing.
   */
  changed: boolean;
}

/**
 * Fold the subscriptions' desired channels into the streamer list.
 *
 * Pure by design -- no clock, no network, no I/O -- because this is the
 * function that decides whether the miner restarts, and that decision
 * has to be exhaustively testable.
 *
 * Two invariants:
 *  - Hand-added streamers are never added, removed or reordered. The
 *    user's roster is theirs; the engine owns only entries carrying an
 *    `ownedBy`.
 *  - A channel the user already added stays manual. Their entry keeps
 *    its own settings, and the subscription simply does not duplicate it.
 */
export function reconcile(
  current: AppConfig["streamers"],
  desired: DesiredEntry[],
): Reconciliation {
  const manual = current.filter((s) => s.ownedBy === undefined);
  const manualLogins = new Set(manual.map((s) => normaliseUsername(s.username)));

  // Drop desired entries the user already owns, and dedupe within the
  // desired list itself (two subscriptions can resolve the same channel).
  const seen = new Set<string>();
  const wanted: DesiredEntry[] = [];
  for (const entry of desired) {
    const login = normaliseUsername(entry.username);
    if (manualLogins.has(login) || seen.has(login)) continue;
    seen.add(login);
    wanted.push(entry);
  }

  // Preserve any existing settings on an owned entry we are keeping, so
  // a re-resolve does not silently reset a channel's configuration.
  const existingOwned = new Map(
    current
      .filter((s) => s.ownedBy !== undefined)
      .map((s) => [normaliseUsername(s.username), s]),
  );

  const owned = wanted.map((entry) => {
    const previous = existingOwned.get(normaliseUsername(entry.username));
    return previous !== undefined
      ? { ...previous, ownedBy: entry.ownedBy }
      : { username: entry.username, ownedBy: entry.ownedBy };
  });

  const streamers = [...manual, ...owned];
  return { streamers, changed: differs(current, streamers) };
}

/** Order-sensitive: order is what upstream's priority_order consumes. */
function differs(
  a: AppConfig["streamers"],
  b: AppConfig["streamers"],
): boolean {
  if (a.length !== b.length) return true;
  return a.some((entry, i) => {
    const other = b[i];
    if (other === undefined) return true;
    return (
      normaliseUsername(entry.username) !== normaliseUsername(other.username) ||
      entry.ownedBy !== other.ownedBy
    );
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/backend test reconcile`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/drops/reconcile.ts apps/backend/src/drops/reconcile.test.ts
git commit -m "feat(drops): reconcile subscription channels against the config"
```

---

### Task 11: Deferred restart

**Files:**
- Create: `apps/backend/src/drops/pendingRestart.ts`
- Test: `apps/backend/src/drops/pendingRestart.test.ts`

**Interfaces:**
- Consumes: a `{ restart(): Promise<void> }` (satisfied by `MinerSupervisor`), and a `broadcast(event, data)` (satisfied by the SSE hub).
- Produces:
  - `export const RESTART_DEFERRAL_MS = 60_000`
  - `export interface PendingState { pending: boolean; dueAt: number | null; reason: string | null }`
  - `export class PendingRestart { propose(reason: string): void; cancel(): void; fireNow(): Promise<void>; state(): PendingState }`

Named `fireNow()`, not `now()`, so it cannot collide with the private clock helper every other cache in this codebase calls `now()`.

Lives entirely above `MinerSupervisor` — it never touches the supervisor's generation-tracking or crash-backoff logic.

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PendingRestart, RESTART_DEFERRAL_MS } from "./pendingRestart.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function make() {
  const restart = vi.fn(async () => {});
  const broadcast = vi.fn();
  return { p: new PendingRestart({ supervisor: { restart }, broadcast }), restart, broadcast };
}

test("a proposal does not restart immediately", () => {
  const { p, restart } = make();
  p.propose("pool changed");
  expect(restart).not.toHaveBeenCalled();
  expect(p.state().pending).toBe(true);
});

test("the restart fires once the deferral elapses", async () => {
  const { p, restart } = make();
  p.propose("pool changed");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(restart).toHaveBeenCalledTimes(1);
  expect(p.state().pending).toBe(false);
});

test("an unattended timer still fires", async () => {
  // Deliberate: waiting for a human would mean subscriptions silently
  // stop working on a box nobody is watching, which is the normal case.
  const { p, restart } = make();
  p.propose("pool changed");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS * 3);
  expect(restart).toHaveBeenCalledTimes(1);
});

test("cancel stops that restart", async () => {
  const { p, restart } = make();
  p.propose("pool changed");
  p.cancel();
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS * 2);
  expect(restart).not.toHaveBeenCalled();
  expect(p.state().pending).toBe(false);
});

test("cancel does not block a later proposal", async () => {
  // A cancel is "not right now", not "never".
  const { p, restart } = make();
  p.propose("pool changed");
  p.cancel();
  p.propose("pool changed again");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(restart).toHaveBeenCalledTimes(1);
});

test("restart now fires without waiting", async () => {
  const { p, restart } = make();
  p.propose("pool changed");
  await p.fireNow();
  expect(restart).toHaveBeenCalledTimes(1);
  expect(p.state().pending).toBe(false);
});

test("a second proposal does not stack a second timer", async () => {
  const { p, restart } = make();
  p.propose("one");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS / 2);
  p.propose("two");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(restart).toHaveBeenCalledTimes(1);
});

test("state changes are broadcast so the banner can follow", () => {
  const { p, broadcast } = make();
  p.propose("pool changed");
  expect(broadcast).toHaveBeenCalledWith(
    "pending-restart",
    expect.objectContaining({ pending: true, reason: "pool changed" }),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/backend test pendingRestart`
Expected: FAIL — cannot resolve `./pendingRestart.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * How long the user gets to cancel an engine-initiated restart.
 *
 * Sixty seconds: long enough that someone watching the dashboard can
 * stop it mid-stream, short enough that an unattended box resumes
 * collecting promptly.
 */
export const RESTART_DEFERRAL_MS = 60_000;

export interface PendingState {
  pending: boolean;
  /** Epoch ms the restart fires, or null when nothing is pending. */
  dueAt: number | null;
  reason: string | null;
}

export interface PendingRestartDeps {
  supervisor: { restart(): Promise<void> };
  broadcast: (event: string, data: unknown) => void;
  now?: () => number;
}

/**
 * A restart the engine wants, held back so a human can veto it.
 *
 * Deliberately sits ABOVE MinerSupervisor. The supervisor's
 * generation-tracking and crash-backoff reasoning is load-bearing and
 * this feature has no business inside it -- a deferral is an intent the
 * engine holds, not a new supervisor state.
 */
export class PendingRestart {
  private timer: NodeJS.Timeout | null = null;
  private dueAt: number | null = null;
  private reason: string | null = null;

  constructor(private readonly deps: PendingRestartDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  state(): PendingState {
    return {
      pending: this.timer !== null,
      dueAt: this.dueAt,
      reason: this.reason,
    };
  }

  private announce(): void {
    this.deps.broadcast("pending-restart", this.state());
  }

  /**
   * Ask for a restart in RESTART_DEFERRAL_MS.
   *
   * Idempotent while one is already pending: a second proposal updates
   * the reason but does not stack another timer or push the deadline
   * out, so a flapping resolution cannot defer the restart forever.
   */
  propose(reason: string): void {
    this.reason = reason;
    if (this.timer !== null) {
      this.announce();
      return;
    }
    this.dueAt = this.now() + RESTART_DEFERRAL_MS;
    this.timer = setTimeout(() => {
      void this.fire();
    }, RESTART_DEFERRAL_MS);
    this.announce();
  }

  /** Drop the pending restart. The next pass may propose a fresh one. */
  cancel(): void {
    this.clear();
    this.announce();
  }

  /** Fire it now rather than waiting out the deferral. */
  async fireNow(): Promise<void> {
    await this.fire();
  }

  private async fire(): Promise<void> {
    this.clear();
    this.announce();
    try {
      await this.deps.supervisor.restart();
    } catch {
      // A failed restart leaves the miner on the previous config, which
      // is still collecting -- the next pass proposes again.
    }
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = null;
    this.reason = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/backend test pendingRestart`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/drops/pendingRestart.ts apps/backend/src/drops/pendingRestart.test.ts
git commit -m "feat(drops): defer engine restarts behind a cancellable countdown"
```

---

### Task 12: Directory op and resolution

**Files:**
- Modify: `python/helpers/state.py` (add a `directory` op)
- Test: `python/tests/test_state.py`
- Create: `apps/backend/src/drops/resolution.ts`
- Test: `apps/backend/src/drops/resolution.test.ts`

**Interfaces:**
- Produces:
  - NDJSON op `"directory"`, params `{game: string, limit: int}`, returning `{"channels": [{"login": str, "channelId": str, "viewers": int}]}`
  - `export interface DirectoryChannel { login: string; channelId: string; viewers: number }`
  - `export interface ResolutionResult { channels: string[]; degraded: boolean }`
  - `export function resolveSubscription(sub: Subscription, campaign: Campaign | undefined, directory: DirectoryChannel[] | null): ResolutionResult`

**This task carries the design's load-bearing risk.** There is no directory/game-listing operation in the vendored miner's `constants.py` — the persisted query hash must be added here and is not maintained upstream. Isolate it behind exactly one function so a rotation is a one-line fix, and make `degraded: true` the honest report when it fails.

- [ ] **Step 1: Write the failing test (TypeScript side first — it is the part that must degrade well)**

```typescript
import { expect, test } from "vitest";
import { resolveSubscription } from "./resolution.js";

const sub = (over: object = {}) => ({
  id: "s1", kind: "campaign", targetId: "c1",
  label: "Alpha", poolSize: 3, rank: 0, ...over,
}) as never;

const campaign = (allow: string[] = []) => ({
  id: "c1", name: "Alpha", game: { id: "g1", slug: "a", displayName: "A" },
  startsAt: 1, endsAt: 2, allowChannelIds: allow, drops: [],
}) as never;

const chan = (login: string, viewers: number) => ({
  login, channelId: `id-${login}`, viewers,
});

test("an allowlisted campaign resolves without the directory at all", () => {
  // These keep working whatever happens to the directory hash.
  const out = resolveSubscription(
    sub(), campaign(["id-alpha", "id-beta"]), null,
  );
  expect(out.degraded).toBe(false);
  expect(out.channels.length).toBeGreaterThan(0);
});

test("an open campaign uses the directory, ranked by viewers", () => {
  const out = resolveSubscription(
    sub(), campaign([]), [chan("alpha", 10), chan("beta", 500), chan("gamma", 90)],
  );
  expect(out.channels).toEqual(["beta", "gamma", "alpha"]);
  expect(out.degraded).toBe(false);
});

test("the pool is capped at poolSize", () => {
  const out = resolveSubscription(
    sub({ poolSize: 2 }), campaign([]),
    [chan("alpha", 10), chan("beta", 500), chan("gamma", 90)],
  );
  expect(out.channels).toEqual(["beta", "gamma"]);
});

test("an open campaign with no directory degrades rather than emptying", () => {
  // Emptying the pool would quietly stop drop collection with no visible
  // cause. Reporting degraded lets the caller keep the previous pool.
  const out = resolveSubscription(sub(), campaign([]), null);
  expect(out.degraded).toBe(true);
  expect(out.channels).toEqual([]);
});

test("an unknown campaign degrades", () => {
  const out = resolveSubscription(sub(), undefined, []);
  expect(out.degraded).toBe(true);
  expect(out.channels).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/backend test resolution`
Expected: FAIL — cannot resolve `./resolution.js`

- [ ] **Step 3: Write the TypeScript implementation**

```typescript
import type { Subscription } from "../config/schema.js";
import type { Campaign } from "../state/campaignCatalogue.js";

export interface DirectoryChannel {
  login: string;
  channelId: string;
  viewers: number;
}

export interface ResolutionResult {
  channels: string[];
  /**
   * True when we could not resolve properly and the caller should keep
   * whatever pool it already has rather than adopting `channels`.
   */
  degraded: boolean;
}

/**
 * The channels a subscription wants watched, best first.
 *
 * Two paths. An allowlisted campaign resolves from catalogue data alone
 * and never touches the directory -- these keep working even when the
 * directory query's hash has rotated. An open campaign needs the
 * directory, and says so honestly when it is unavailable.
 *
 * `degraded` never means "use an empty pool": emptying a pool silently
 * stops drop collection, which is the one failure the user cannot see.
 */
export function resolveSubscription(
  sub: Subscription,
  campaign: Campaign | undefined,
  directory: DirectoryChannel[] | null,
): ResolutionResult {
  if (campaign === undefined) return { channels: [], degraded: true };

  if (campaign.allowChannelIds.length > 0) {
    const allowed = new Set(campaign.allowChannelIds);
    // Prefer directory data when we have it, so the allowlisted channels
    // we pick are the ones actually live; fall back to the raw ids.
    const live = (directory ?? []).filter((c) => allowed.has(c.channelId));
    const ranked =
      live.length > 0
        ? [...live].sort((a, b) => b.viewers - a.viewers).map((c) => c.login)
        : campaign.allowChannelIds;
    return { channels: ranked.slice(0, sub.poolSize), degraded: false };
  }

  if (directory === null) return { channels: [], degraded: true };

  // Viewers descending: a bigger channel is likelier to stay live for
  // the length of a drop, which is what the pool is protecting against.
  return {
    channels: [...directory]
      .sort((a, b) => b.viewers - a.viewers)
      .slice(0, sub.poolSize)
      .map((c) => c.login),
    degraded: false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/backend test resolution`
Expected: PASS (5 tests)

- [ ] **Step 5: Add the Python `directory` op**

Add to `python/helpers/state.py` a `_directory(game, limit)` method issuing a `DirectoryPage_Game`-style persisted query, filtered to streams tagged with drops enabled. Put the operation definition in one module-level constant with a comment recording that **this hash is ours, not upstream's, and will break when Twitch rotates it.** On any failure raise — the TypeScript caller turns that into `directory: null`, which resolution already handles as `degraded`.

Test it the same way as Tasks 1-2, with a `SimpleNamespace` fake returning a channel list, plus a test that an exception propagates rather than yielding an empty list (an empty list would be read as "no channels are live", which is a different and wrong claim).

- [ ] **Step 6: Run the Python tests**

Run: `cd /workspace && pytest python/tests/test_state.py -k directory -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/drops/resolution.ts apps/backend/src/drops/resolution.test.ts python/helpers/state.py python/tests/test_state.py
git commit -m "feat(drops): resolve subscriptions to candidate channels"
```

---

### Task 13: The engine

**Files:**
- Create: `apps/backend/src/drops/engine.ts`
- Test: `apps/backend/src/drops/engine.test.ts`

**Interfaces:**
- Consumes: `CampaignCatalogue` (3), `reconcile` (10), `PendingRestart` (11), `resolveSubscription` (12), `loadConfig`/`saveConfig` from `config/store.js`.
- Produces:
  - `export const RECONCILE_INTERVAL_MS = 900_000`
  - `export class SubscriptionEngine { start(): void; stop(): void; pass(): Promise<void> }`

`pass()` is public so tests drive it directly rather than through timers.

- [ ] **Step 1: Write the failing test**

```typescript
import { expect, test, vi } from "vitest";
import { SubscriptionEngine } from "./engine.js";

function make(over: object = {}) {
  const config = {
    streamers: [{ username: "alpha" }],
    subscriptions: [{ id: "s1", kind: "campaign", targetId: "c1",
                      label: "Alpha", poolSize: 2, rank: 0 }],
  };
  const save = vi.fn();
  const propose = vi.fn();
  const engine = new SubscriptionEngine({
    loadConfig: () => config as never,
    saveConfig: save,
    catalogue: { get: async () => ({
      campaigns: [{ id: "c1", name: "Alpha",
                    game: { id: "g1", slug: "a", displayName: "A" },
                    startsAt: 1, endsAt: 2,
                    allowChannelIds: ["id-beta", "id-gamma"], drops: [] }],
      fetchedAt: 1, stale: false,
    }) } as never,
    directory: async () => [
      { login: "beta", channelId: "id-beta", viewers: 100 },
      { login: "gamma", channelId: "id-gamma", viewers: 50 },
    ],
    pending: { propose } as never,
    ...over,
  });
  return { engine, save, propose, config };
}

test("a pass writes the resolved pool and proposes a restart", async () => {
  const { engine, save, propose } = make();
  await engine.pass();
  expect(save).toHaveBeenCalledTimes(1);
  const written = save.mock.calls[0]?.[1] as { streamers: { username: string }[] };
  expect(written.streamers.map((s) => s.username)).toEqual(["alpha", "beta", "gamma"]);
  expect(propose).toHaveBeenCalledTimes(1);
});

test("an unchanged pass writes nothing and proposes nothing", async () => {
  const { engine, save, propose } = make({
    loadConfig: () => ({
      streamers: [{ username: "alpha" },
                  { username: "beta", ownedBy: "s1" },
                  { username: "gamma", ownedBy: "s1" }],
      subscriptions: [{ id: "s1", kind: "campaign", targetId: "c1",
                        label: "Alpha", poolSize: 2, rank: 0 }],
    }),
  });
  await engine.pass();
  expect(save).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});

test("a degraded resolution keeps the existing pool untouched", async () => {
  // Never empty a pool on a directory failure -- that silently stops
  // collection with no visible cause.
  const { engine, save, propose } = make({
    loadConfig: () => ({
      streamers: [{ username: "alpha" }, { username: "beta", ownedBy: "s1" }],
      subscriptions: [{ id: "s1", kind: "campaign", targetId: "c9",
                        label: "Gone", poolSize: 2, rank: 0 }],
    }),
    directory: async () => { throw new Error("hash rotated"); },
  });
  await engine.pass();
  expect(save).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});

test("subscriptions resolve in rank order", async () => {
  const { engine, save } = make({
    loadConfig: () => ({
      streamers: [],
      subscriptions: [
        { id: "s2", kind: "campaign", targetId: "c1", label: "B", poolSize: 1, rank: 1 },
        { id: "s1", kind: "campaign", targetId: "c1", label: "A", poolSize: 1, rank: 0 },
      ],
    }),
  });
  await engine.pass();
  const written = save.mock.calls[0]?.[1] as { streamers: { ownedBy?: string }[] };
  // Rank 0 fills the miner's slots first -- it is what priority_order reads.
  expect(written.streamers[0]?.ownedBy).toBe("s1");
});

test("no subscriptions means no work", async () => {
  const { engine, save, propose } = make({
    loadConfig: () => ({ streamers: [{ username: "alpha" }], subscriptions: [] }),
  });
  await engine.pass();
  expect(save).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});

test("an ended campaign drops its pool and its subscription", async () => {
  // The mirror image of the degraded case, and the reason `stale`
  // matters: a campaign missing from a FRESH catalogue has ended, so
  // its channels should go. Missing because the fetch failed is the
  // other case, tested above, where they must stay.
  const { engine, save, propose } = make({
    loadConfig: () => ({
      streamers: [{ username: "alpha" }, { username: "beta", ownedBy: "s1" }],
      subscriptions: [{ id: "s1", kind: "campaign", targetId: "gone",
                        label: "Ended", poolSize: 2, rank: 0 }],
    }),
  });
  await engine.pass();
  const written = save.mock.calls[0]?.[1] as {
    streamers: { username: string }[];
    subscriptions: unknown[];
  };
  expect(written.streamers.map((s) => s.username)).toEqual(["alpha"]);
  expect(written.subscriptions).toEqual([]);
  expect(propose).toHaveBeenCalledTimes(1);
});

test("a stale catalogue never ends a campaign", async () => {
  // Same missing campaign, but the catalogue could not be refreshed --
  // concluding "ended" from a stale list would delete a live
  // subscription over a network blip.
  const { engine, save, propose } = make({
    loadConfig: () => ({
      streamers: [{ username: "alpha" }, { username: "beta", ownedBy: "s1" }],
      subscriptions: [{ id: "s1", kind: "campaign", targetId: "gone",
                        label: "Maybe Ended", poolSize: 2, rank: 0 }],
    }),
    catalogue: { get: async () => ({ campaigns: [], fetchedAt: 1, stale: true }) },
  });
  await engine.pass();
  expect(save).not.toHaveBeenCalled();
  expect(propose).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/backend test engine`
Expected: FAIL — cannot resolve `./engine.js`

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { AppConfig } from "../config/schema.js";
import type { CampaignCatalogue } from "../state/campaignCatalogue.js";
import type { PendingRestart } from "./pendingRestart.js";
import { reconcile, type DesiredEntry } from "./reconcile.js";
import { resolveSubscription, type DirectoryChannel } from "./resolution.js";

/**
 * How often subscriptions are re-resolved.
 *
 * Fifteen minutes. This is the cadence at which a WHOLE pool can go
 * stale, not the cadence at which channels go offline -- the pool
 * absorbs that without help, because the miner's own selector moves
 * down the list. Well under the shortest meaningful drop (30 minutes),
 * so a fully dead pool costs at most half a drop's progress.
 */
export const RECONCILE_INTERVAL_MS = 900_000;

export interface EngineDeps {
  loadConfig: () => AppConfig;
  saveConfig: (path: string, config: AppConfig) => void;
  configPath?: string;
  catalogue: CampaignCatalogue;
  directory: (gameId: string) => Promise<DirectoryChannel[]>;
  pending: PendingRestart;
}

/** Keeps the config's subscription-owned channels in step with intent. */
export class SubscriptionEngine {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: EngineDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.pass().catch(() => {
        // A failed pass is not fatal: the next one tries again, and the
        // config still holds the previous, working pool.
      });
    }, RECONCILE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One resolve-reconcile-propose cycle. Public so tests drive it. */
  async pass(): Promise<void> {
    const config = this.deps.loadConfig();
    if (config.subscriptions.length === 0) return;

    const { campaigns, stale } = await this.deps.catalogue.get();
    const byId = new Map(campaigns.map((c) => [c.id, c]));

    // Rank order: lower ranks fill the miner's watch slots first, and
    // the written order is what upstream's priority_order consumes.
    const ordered = [...config.subscriptions].sort((a, b) => a.rank - b.rank);

    const desired: DesiredEntry[] = [];
    const ended = new Set<string>();

    for (const sub of ordered) {
      const campaign = byId.get(sub.targetId);

      // A campaign missing from a FRESH catalogue has ended: the
      // catalogue holds ACTIVE campaigns only, so absence is the end
      // signal. Absence from a STALE one means we simply could not
      // look -- concluding "ended" there would delete a live
      // subscription over a network blip.
      if (campaign === undefined && !stale && sub.kind === "campaign") {
        ended.add(sub.id);
        continue;
      }

      let directory: DirectoryChannel[] | null = null;
      try {
        const gameId = campaign?.game?.id ?? sub.targetId;
        directory = await this.deps.directory(gameId);
      } catch {
        // Left null: resolution reports this as degraded.
      }
      const result = resolveSubscription(sub, campaign, directory);
      if (result.degraded) {
        // Keep whatever this subscription already owns rather than
        // dropping it -- an empty pool stops collection invisibly.
        for (const s of config.streamers) {
          if (s.ownedBy === sub.id) {
            desired.push({ username: s.username, ownedBy: sub.id });
          }
        }
        continue;
      }
      for (const login of result.channels) {
        desired.push({ username: login, ownedBy: sub.id });
      }
    }

    const { streamers, changed } = reconcile(config.streamers, desired);
    if (!changed && ended.size === 0) return;

    this.deps.saveConfig(this.deps.configPath ?? "", {
      ...config,
      streamers,
      subscriptions: config.subscriptions.filter((s) => !ended.has(s.id)),
    });
    this.deps.pending.propose(
      ended.size > 0
        ? "a drop campaign ended"
        : "drop subscriptions resolved new channels",
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/backend test engine`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/drops/engine.ts apps/backend/src/drops/engine.test.ts
git commit -m "feat(drops): drive subscription resolution on a 15 minute pass"
```

---

### Task 14: Subscription routes and restart banner

**Files:**
- Modify: `apps/backend/src/http/server.ts`
- Modify: `apps/backend/src/index.ts` (construct the engine and pending restart, start the engine)
- Test: `apps/backend/src/http/server.test.ts`
- Create: `apps/frontend/src/components/RestartBanner.tsx`
- Test: `apps/frontend/src/components/RestartBanner.test.tsx`

**Interfaces:**
- Produces:
  - `GET /api/subscriptions` → `{ subscriptions: Subscription[] }`
  - `POST /api/subscriptions` → creates one (body: `kind`, `targetId`, `label`, optional `poolSize`), assigns `id` and next `rank`
  - `DELETE /api/subscriptions/:id` → removes it, and removes the streamers it owned
  - `PATCH /api/subscriptions/reorder` → body `{ ids: string[] }`, rewrites ranks
  - `POST /api/restart/cancel`, `POST /api/restart/now`
  - SSE event `pending-restart` carrying `PendingState`

- [ ] **Step 1: Write the failing test**

```typescript
test("creating a subscription assigns an id and the next rank", async () => {
  const app = await buildTestApp({ /* config with no subscriptions */ });
  const res = await app.inject({
    method: "POST", url: "/api/subscriptions",
    payload: { kind: "campaign", targetId: "c1", label: "Alpha" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().subscription.rank).toBe(0);
  expect(res.json().subscription.poolSize).toBe(3);
});

test("deleting a subscription also drops the streamers it owned", async () => {
  const app = await buildTestApp({
    config: {
      streamers: [{ username: "alpha" }, { username: "beta", ownedBy: "s1" }],
      subscriptions: [{ id: "s1", kind: "campaign", targetId: "c1",
                        label: "Alpha", poolSize: 3, rank: 0 }],
    },
  });
  const res = await app.inject({ method: "DELETE", url: "/api/subscriptions/s1" });
  expect(res.statusCode).toBe(200);
  const saved = savedConfig();
  expect(saved.streamers.map((s) => s.username)).toEqual(["alpha"]);
  expect(saved.subscriptions).toEqual([]);
});

test("reorder rewrites ranks in the given order", async () => {
  const app = await buildTestApp({
    config: {
      streamers: [],
      subscriptions: [
        { id: "s1", kind: "campaign", targetId: "c1", label: "A", poolSize: 3, rank: 0 },
        { id: "s2", kind: "campaign", targetId: "c2", label: "B", poolSize: 3, rank: 1 },
      ],
    },
  });
  await app.inject({
    method: "PATCH", url: "/api/subscriptions/reorder",
    payload: { ids: ["s2", "s1"] },
  });
  const saved = savedConfig();
  expect(saved.subscriptions.find((s) => s.id === "s2")?.rank).toBe(0);
});

test("cancelling a pending restart calls through", async () => {
  const cancel = vi.fn();
  const app = await buildTestApp({ pending: { cancel, state: () => ({ pending: false, dueAt: null, reason: null }) } });
  const res = await app.inject({ method: "POST", url: "/api/restart/cancel" });
  expect(res.statusCode).toBe(200);
  expect(cancel).toHaveBeenCalledTimes(1);
});
```

And for the banner:

```tsx
test("shows the countdown and both actions while pending", () => {
  renderApp(<RestartBanner state={{ pending: true, dueAt: Date.now() + 60_000,
                                    reason: "drop subscriptions resolved new channels" }}
                           onCancel={() => {}} onNow={() => {}} />);
  expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
  expect(screen.getByRole("button", { name: /restart now/i })).toBeTruthy();
});

test("renders nothing when no restart is pending", () => {
  const { container } = renderApp(
    <RestartBanner state={{ pending: false, dueAt: null, reason: null }}
                   onCancel={() => {}} onNow={() => {}} />,
  );
  expect(container.firstChild).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /workspace && pnpm --filter @app/backend test server && pnpm --filter @app/frontend test RestartBanner`
Expected: FAIL — 404s, and no `RestartBanner` module

- [ ] **Step 3: Write minimal implementation**

Add the five routes to `server.ts` following the existing authenticated-route idiom. `DELETE` must strip owned streamers in the same `saveConfig` call as the subscription removal, so the two can never disagree.

**The `api` client has no `delete` method** — `api/client.ts:20` exports only `get`, `post` and `put`. Add a `del` (or `remove`) method alongside them, following `send`'s existing signature. Do not name it `delete`; that is a reserved word and an awkward property name here.

`RestartBanner.tsx` renders null unless `state.pending`, otherwise a Mantine `Alert` with the reason, a live countdown to `dueAt`, and the two buttons. Subscribe to the `pending-restart` SSE event in `api/useLiveState.ts`, where the app already handles the stream.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /workspace && pnpm --filter @app/backend test server && pnpm --filter @app/frontend test RestartBanner`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src apps/frontend/src
git commit -m "feat(api): manage drop subscriptions and deferred restarts"
```

---

### Task 15: Subscribe from the Drops page

**Files:**
- Modify: `apps/frontend/src/components/CampaignCard.tsx`
- Modify: `apps/frontend/src/routes/Drops.tsx`
- Test: `apps/frontend/src/routes/Drops.test.tsx`

**Interfaces:**
- Consumes: the subscription routes from Task 14.
- Produces: a Subscribe/Unsubscribe control per campaign, a subscriptions list showing each one's resolved channels, drag-to-reorder, and a manual re-resolve button.

The manual re-resolve is the piece of "Approach C" the spec folded into A: an escape hatch so you are never waiting on the timer.

- [ ] **Step 1: Write the failing test**

Extend the `beforeEach` fetch stub from Task 8 to route by URL, the way
`routes/Streamers.test.tsx` does:

```tsx
let subscriptions: unknown[];

beforeEach(() => {
  calls = [];
  body = payload;
  subscriptions = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/subscriptions") {
      return { ok: true, status: 200, json: async () => ({ subscriptions }) };
    }
    return { ok: true, status: 200, json: async () => body };
  }));
});

test("subscribing posts the campaign", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.click(screen.getAllByRole("button", { name: /^subscribe/i })[0]!);
  await waitFor(() => {
    const post = calls.find(
      (c) => c.url === "/api/subscriptions" && c.init?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      kind: "campaign", targetId: "c1",
    });
  });
});

test("an already-subscribed campaign offers unsubscribe instead", async () => {
  subscriptions = [{ id: "s1", kind: "campaign", targetId: "c1",
                     label: "Alpha Campaign", poolSize: 3, rank: 0, channels: [] }];
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /unsubscribe/i })).toBeTruthy());
});

test("the subscriptions list shows the channels each one resolved to", async () => {
  subscriptions = [{ id: "s1", kind: "campaign", targetId: "c1",
                     label: "Alpha Campaign", poolSize: 3, rank: 0,
                     channels: ["beta", "gamma"] }];
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("beta")).toBeTruthy());
  expect(screen.getByText("gamma")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /workspace && pnpm --filter @app/frontend test Drops`
Expected: FAIL — no subscribe control

- [ ] **Step 3: Write minimal implementation**

Add the control to `CampaignCard`, a subscriptions panel to `Drops.tsx` reading `GET /api/subscriptions` (extended server-side to include each subscription's currently-owned channel logins, read off `config.streamers` by `ownedBy`), drag-to-reorder calling the reorder route, and a "Re-resolve now" button triggering an immediate engine pass via a small `POST /api/subscriptions/resolve` route.

Reordering uses `@dnd-kit`, following `routes/Streamers.tsx` — do not hand-roll it. If you test the drag itself, call `stubRowRects("subscription-row")` in a `beforeEach` and `restoreRects()` in an `afterEach`: jsdom reports every `getBoundingClientRect` as 0x0, so without the stub a drag test passes against a component that reorders nothing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /workspace && pnpm --filter @app/frontend test Drops`
Expected: PASS

- [ ] **Step 5: Run everything**

Run: `cd /workspace && pnpm test && pytest python/tests -q`
Expected: PASS across all three suites

- [ ] **Step 6: Verify in the real app**

Subscribe to a campaign, confirm channels appear in the streamer list badged with the campaign, confirm the restart banner appears and cancels cleanly. Screenshot for review.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src apps/backend/src
git commit -m "feat(ui): subscribe to drop campaigns from the Drops page"
```

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task(s) |
|---|---|
| What Twitch actually gives us | 1, 2, 12 |
| Three clocks | 3, 4, 13 |
| Campaign catalogue + manual refresh + failure | 3, 6 |
| Drop state (six states) | 5 |
| The Drops page | 7, 8 |
| Subscriptions (intent, order, pool size) | 9, 13, 15 |
| Temporary streamer entries | 9, 10, 14 |
| Three modules | 10 (reconcile), 12 (resolution), 3 (catalogue) |
| Deferred restart | 11, 14 |
| The directory query + degradation | 12, 13 |
| Testing | every task |

**Campaign end cleanup** was found missing during this review and is now
handled in Task 13, with two tests. The distinction it turns on is worth
restating because it is easy to get backwards:

- Campaign absent from a **fresh** catalogue → it ended (the catalogue
  holds `ACTIVE` only). Drop its pool and its subscription.
- Campaign absent from a **stale** catalogue → we could not look. Keep
  everything. Concluding "ended" here would delete a live subscription
  over a network blip.

**The one thing this plan cannot supply:** Task 12's persisted query
hash. A working hash must be captured from a live Twitch session; it
cannot be invented here. Flagged rather than hidden, and it is the
feature's known fragility — see the spec's *The directory query*.

**Type consistency, checked:**
- `Campaign`/`CampaignDrop` (Task 3) flow into Tasks 5, 12, 13 unchanged.
- `InventorySnapshot.available` (Task 4) is consumed by `resolveDrop` (Task 5) and is the whole reason `unknown` can be distinguished from `not-started`.
- `Catalogue` carries `stale` (Task 3), which Task 13 now reads — test fakes for `catalogue.get()` must return `{ campaigns, fetchedAt, stale }`, all three.
- `DesiredEntry` (Task 10) is produced by Task 13.
- `PendingRestart.fireNow()` (Task 11) is named to avoid colliding with the private `now()` clock helper used by every cache here.

**Verified against the codebase during review** (these were wrong in the first draft and are now corrected): screens live in `routes/`, not `pages/`; tests use `renderApp` from `test-utils.js` and a stubbed global `fetch`, not injected fetcher props; `api` has no `delete` method; `@dnd-kit` is already the reordering tool; `@tanstack/react-query` is a dependency but unused by any route.
