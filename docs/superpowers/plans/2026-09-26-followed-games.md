# Followed Games Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user follow Twitch games from the Drops page, found through a live Twitch category search, so the drops engine subscribes to each of the game's campaigns automatically as they appear.

**Architecture:** The old `game` subscription kind is removed. A top-level `followedGames` list in the config holds the games the user follows. A pure function (`drops/follow.ts`) decides which catalogue campaigns become new campaign subscriptions (tagged `viaGame`), and the engine runs it at the start of every pass. Category search is a small Node GQL client (`twitch/categories.ts`) behind `GET /api/games/search`. The frontend adds a Followed games card, a search dialog, an Auto badge and a "Follow game" shortcut on campaign cards.

**Tech Stack:** Node 24 + Fastify + Zod (backend), React 19 + Mantine 9 + `@mantine/hooks` (frontend), vitest + Testing Library, Playwright from `~/.pw-tools` for the real-app check.

**Spec:** `docs/superpowers/specs/2026-09-26-followed-games-design.md`

## Global Constraints

- **No commits during tasks.** The user reviews the full change before anything is committed (their standing preference). Each task ends at a green checkpoint. Task 10 shows the diff, waits for approval, then commits straight to `main`.
- **No back-compat.** A config holding a `kind` field on a subscription fails to load after Task 1. That is accepted, since no UI ever wrote one.
- **Comments describe current code.** Don't mention the removed `game` kind in new comments. Keep only what stops a future break.
- **Tests run in the local timezone** (Europe/Berlin, no TZ pin). Build any day-based fixture in local time.
- **Mantine overlays work under vitest.** Modal and Tooltip render. Query options inside a Combobox with `{ hidden: true }` if needed.
- Twitch GQL: `https://gql.twitch.tv/gql`, header `Client-Id: kimne78kx3ncx6brgo4mv6wki5h1ko`, plain `query` + `variables` (never string-interpolated), 5-second timeout. Box art is requested at `boxArtURL(width: 144, height: 192)`.
- Pool size for followed games: an integer from 1 to 10, default 3. Reuse `subscriptionSchema.shape.poolSize`.
- `POST /api/followed-games` accepts 1–25 IDs.
- Search returns at most 10 results. Queries shorter than 2 characters (after trimming) return `[]` without calling Twitch.
- Dialog search is debounced by 300 ms.
- `campaign.new` becomes `defaultOn: true` and fires only on `"timer"` and `"boot"` passes.
- **Spec deviation (declared):** `@mantine/notifications` is not installed. The "Following 3 games · 2 campaigns subscribed" confirmation is an inline notice in the Followed games card, not a toast. Don't add the dependency.
- **Spec deviation (declared, Review Focus #3):** removing *any* subscription to a campaign whose game is followed records the campaign in that game's `skipped` list. That includes one the user added by hand before following the game. Otherwise the game would re-add it on the next pass, which contradicts the removal the user just made.

## Review Focus

Five inputs the spec implies but no feature test would naturally cover. Each one has a pinned test in the task that owns the code.

1. **Search text with quotes or GraphQL syntax** (`Tom Clancy's "Rainbow"`, `}{`) must reach Twitch unchanged as a variable and never break the query. Pinned in Task 2.
2. **The same ID twice in one follow request** (`["512953","512953"]`) must follow the game once and look it up on Twitch once. Pinned in Task 5.
3. **Removing a hand-added subscription for a followed game's campaign** must not have the game re-add it on the next pass. Pinned in Task 5.
4. **Search responses arriving out of order** (a slow "el" landing after a fast "elden") must not overwrite the newer results. Pinned in Task 8.
5. **A followed game with several new campaigns, where existing ranks have gaps** (ranks `[0, 5]`) must get every campaign, in catalogue order, with ranks `6, 7`, never reusing a rank. Pinned in Task 3.

---

## File Structure

**Backend**
- Modify `apps/backend/src/config/schema.ts`: drop `kind`, add `viaGame`, `followedGameSchema` and `followedGames`.
- Create `apps/backend/src/twitch/categories.ts`: the Twitch GQL client (`search`, `byId`, `find`).
- Create `apps/backend/src/drops/follow.ts`: the pure functions `followGames()` and `recordSkipped()`.
- Modify `apps/backend/src/drops/engine.ts`: run the follow step, record skips, add the `onCampaignFollowed` hook and the `"follow"` trigger.
- Modify `apps/backend/src/drops/resolution.ts` and `apps/backend/src/drops/queue.ts`: remove the game branches.
- Modify `apps/backend/src/http/server.ts`: add the followed-games and search routes, and update the subscription routes.
- Modify `apps/backend/src/appLog/types.ts`: add the new event names.
- Modify `apps/backend/src/notify/sources/campaigns.ts` and `apps/backend/src/notify/catalogue.ts`: move `campaign.new`.
- Modify `apps/backend/src/index.ts`: wiring.

**Frontend**
- Create `apps/frontend/src/lib/followedGames.ts`: shared types, `runningCampaigns()`, `followSummary()`.
- Create `apps/frontend/src/components/PoolSizeInput.tsx` + `.module.css`: extracted from the Drops row.
- Create `apps/frontend/src/components/FollowedGamesCard.tsx`.
- Create `apps/frontend/src/components/FollowGamesDialog.tsx`.
- Modify `apps/frontend/src/components/CampaignCard.tsx`: add the Follow game shortcut.
- Modify `apps/frontend/src/routes/Drops.tsx` + `Drops.module.css`: wiring, the Auto badge, removal of `kind`.

**Docs**
- Modify `README.md`: a short "Following games" paragraph under `### Drops`.

---

### Task 1: Remove the game subscription kind; add followed games to the config

**Files:**
- Modify: `apps/backend/src/config/schema.ts:175-205` (subscriptionSchema) and `:207-252` (configSchema)
- Modify: `apps/backend/src/drops/resolution.ts:52-73,142-149`
- Modify: `apps/backend/src/drops/queue.ts:27-41`
- Modify: `apps/backend/src/drops/engine.ts:176-181,193-232,269,325`
- Modify: `apps/backend/src/http/server.ts:254-268,675-734`
- Modify: `apps/backend/src/index.ts:291-311,451-453`
- Test: `apps/backend/src/config/store.test.ts`, `apps/backend/src/drops/{engine,resolution,queue}.test.ts`, `apps/backend/src/http/server.test.ts`

**Interfaces:**
- Produces: `Subscription = { id; targetId; label; poolSize; rank; viaGame?: string }`. `FollowedGame = { id; name; slug; boxArtUrl: string | null; poolSize; skipped: string[] }`. `followedGameSchema`. `AppConfig.followedGames: FollowedGame[]` (defaults to `[]`). `directoryTarget(campaign)` now takes only the campaign.

- [ ] **Step 1: Write the failing schema tests**

In `apps/backend/src/config/store.test.ts`, delete the tests `"accepts a game subscription"` and `"rejects an unknown subscription kind"`, and remove `kind: "campaign", ` from every remaining subscription fixture in the file. Then add:

```ts
  test("rejects a subscription that still carries a kind", () => {
    const bad = {
      ...valid,
      subscriptions: [{ id: "s1", kind: "game", targetId: "g1",
                        label: "Once Human", rank: 0 }],
    };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  test("a subscription may record the followed game that added it", () => {
    const parsed = configSchema.parse({
      ...valid,
      subscriptions: [{ id: "s1", targetId: "c1", label: "a", rank: 0, viaGame: "512953" }],
    });
    expect(parsed.subscriptions[0]?.viaGame).toBe("512953");
  });

  test("followed games default to none, and fill in pool size and skipped", () => {
    expect(configSchema.parse(valid).followedGames).toEqual([]);
    const parsed = configSchema.parse({
      ...valid,
      followedGames: [{ id: "512953", name: "ELDEN RING", slug: "elden-ring", boxArtUrl: null }],
    });
    expect(parsed.followedGames[0]).toEqual({
      id: "512953", name: "ELDEN RING", slug: "elden-ring", boxArtUrl: null,
      poolSize: 3, skipped: [],
    });
  });

  test("rejects the same game followed twice", () => {
    const game = { id: "512953", name: "ELDEN RING", slug: "elden-ring", boxArtUrl: null };
    expect(configSchema.safeParse({ ...valid, followedGames: [game, game] }).success).toBe(false);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/config/store.test.ts`
Expected: FAIL. The `kind` test passes parsing, `viaGame` is rejected by `.strict()`, and `followedGames` is an unknown key.

- [ ] **Step 3: Change the schema**

In `apps/backend/src/config/schema.ts`, replace `subscriptionSchema` with the following. Keep the existing doc comments on `label`, `poolSize` and `rank`.

```ts
export const subscriptionSchema = z.object({
  id: z.string().min(1),
  /** The campaign this subscription collects. */
  targetId: z.string().min(1),
  /** (existing label comment) */
  label: z.string().min(1),
  /** (existing poolSize comment) */
  poolSize: z.number().int().min(1).max(10).default(3),
  /** Lower ranks fill the miner's watch slots first. */
  rank: z.number().int().min(0),
  /**
   * The followed game that added this subscription, when one did.
   *
   * Absent means the user subscribed by hand. When a subscription with
   * this set leaves, its campaign is recorded in that game's `skipped`
   * so the game does not add it back.
   */
  viaGame: z.string().min(1).optional(),
}).strict();

export type Subscription = z.infer<typeof subscriptionSchema>;

/**
 * A Twitch game whose drop campaigns are subscribed to as they appear.
 *
 * Mines nothing itself: each pass turns its catalogue campaigns into
 * ordinary campaign subscriptions (see drops/follow.ts). Name, slug and
 * box art are what Twitch returned when it was followed.
 */
export const followedGameSchema = z.object({
  /** Twitch game id; the same id the campaign catalogue carries. */
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string(),
  boxArtUrl: z.string().nullable(),
  /** Copied onto each campaign subscription this game adds. */
  poolSize: subscriptionSchema.shape.poolSize,
  /**
   * Campaigns this game must not subscribe to again: ones the user
   * removed, or that ended or completed. Pruned once a campaign leaves
   * a trustworthy catalogue, so it holds running campaigns only.
   */
  skipped: z.array(z.string().min(1)).default([]),
}).strict();

export type FollowedGame = z.infer<typeof followedGameSchema>;
```

In `configSchema`, after `subscriptions`, add:

```ts
    followedGames: z
      .array(followedGameSchema)
      .default([])
      .refine(
        (list) => new Set(list.map((g) => g.id)).size === list.length,
        { message: "duplicate followed game" },
      ),
```

Remove the sentence "Game subscriptions are not queued." from the `campaignQueue` comment.

- [ ] **Step 4: Run the schema tests**

Run: `pnpm --filter @app/backend exec vitest run src/config/store.test.ts`
Expected: PASS

- [ ] **Step 5: Delete the game-kind tests elsewhere and drop `kind` from fixtures**

- `apps/backend/src/drops/resolution.test.ts`: delete `"a game subscription resolves without needing a campaign"`, and remove `kind: "campaign", ` from the `sub` fixture (line 7).
- `apps/backend/src/drops/queue.test.ts`: delete `"game subscriptions are not queued"`, and remove `kind: "campaign", ` from the `sub` fixture (line 7).
- `apps/backend/src/drops/engine.test.ts`:
  - delete `"a game subscription outlives the campaign catalogue"`, `"a game subscription is never ended by one campaign"` and `"game subscriptions keep their channels with the queue on"`;
  - in `sub()` (line 15), remove `kind: "campaign" as const, `;
  - in `make()`'s default `config`, add `followedGames: [],` after `subscriptions: [sub()],`, because the engine reads it unparsed.
- `apps/backend/src/http/server.test.ts`:
  - in `aSub` (line 1516), remove `kind: "campaign", `;
  - in every `payload: { kind: "campaign", targetId: …` of `POST /api/subscriptions`, remove `kind: "campaign", `;
  - in `"GET /api/subscriptions reports each campaign's place in the queue"`, delete the third `aSub({ id: "g", kind: "game", … })` entry and the trailing `null` in the expected array.

Add this server test next to the other `POST /api/subscriptions` tests:

```ts
test("POST /api/subscriptions will not take a viaGame from the client", async () => {
  // Only the engine tags a subscription with the game that added it.
  withSubs([]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions", cookies: auth(),
    payload: { targetId: "c1", label: "Alpha", viaGame: "g1" },
  });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 6: Remove the kind from the code**

`apps/backend/src/drops/resolution.ts`: replace `target()` and `directoryTarget()`, and change the call in `resolveSubscription` to `target(campaign)`:

```ts
/**
 * Which game a subscription's campaign is for, or null when unanswerable.
 *
 * Taken from the campaign, so a subscription stops resolving once its
 * campaign leaves the catalogue.
 */
function target(
  campaign: Campaign | undefined,
): { id: string; name: string; slug: string } | null {
  if (campaign?.game == null) return null;
  return {
    id: campaign.game.id,
    name: campaign.game.displayName,
    slug: campaign.game.slug,
  };
}
```

```ts
/** The game to ask the directory about, for a subscription's campaign. */
export function directoryTarget(
  campaign: Campaign | undefined,
): { name: string; slug: string } | null {
  const game = target(campaign);
  return game === null ? null : { name: game.name, slug: game.slug };
}
```

`apps/backend/src/drops/queue.ts`: change line 41 to `if (done.has(sub.id)) continue;`. Delete the sentence "Game subscriptions are not queued and get no entry." from the doc comment.

`apps/backend/src/drops/engine.ts`:
- Replace lines 176-181 with:

  ```ts
      // InventoryCache.get() never rejects.
      const inventory = this.deps.inventory !== undefined
        ? await this.deps.inventory.get()
        : null;
  ```

- Remove `sub.kind === "campaign" && ` from the three conditions at lines 200, 217 and 232. In the comment above line 200, delete the sentence starting "Game subscriptions are never ended this way".
- Line 269: `const opensAt = campaign?.startsAt;`
- Line 325: `const game = directoryTarget(campaign);`

`apps/backend/src/http/server.ts`:
- Replace `gameForSubscription` (lines 254-268):

  ```ts
  /**
   * The game a subscription's campaign is for, from the campaigns on hand.
   *
   * Null when the campaign is unknown or carries no game -- a guess would
   * be worse.
   */
  function gameForSubscription(
    sub: { targetId: string },
    campaigns: readonly Campaign[],
  ): string | null {
    const name = campaigns.find((c) => c.id === sub.targetId)?.game?.displayName;
    return name === undefined || name === "" ? null : name;
  }
  ```

- In `POST /api/subscriptions`:
  - parse with `subscriptionSchema.omit({ id: true, rank: true, viaGame: true })`;
  - make the clash check `(s) => s.targetId === body.data.targetId`;
  - remove the `if (body.data.kind === "campaign") {` wrapper, keeping its body;
  - change the log `msg` to `` `subscribed to "${subscription.label}"` `` and delete the `kind:` field.
- In `GET /api/subscriptions`, change the queue comment to "Null when the queue is off."

`apps/backend/src/index.ts`:
- Replace `gameForSubscription` (lines 302-311) with the campaign-only lookup:

  ```ts
  function gameForSubscription(sub: { targetId: string }): string | null {
    const campaigns = catalogue.peek()?.campaigns ?? [];
    const name = campaigns.find((c) => c.id === sub.targetId)?.game?.displayName;
    return name === undefined || name === "" ? null : name;
  }
  ```

  In the doc comment above it, delete the sentences about "A game subscription targets the game directly".
- Replace `subscribedGames` (lines 451-453) with:

  ```ts
    subscribedGames: () => loadConfig(configPath).followedGames.map((g) => g.id),
  ```

  This is interim; Task 6 deletes it.

- [ ] **Step 7: Run the backend suite and the type check**

Run: `pnpm --filter @app/backend test && pnpm run build:backend`
Expected: all PASS, and `tsc` exits 0. If `tsc` reports another `.kind` on a subscription, remove it the same way.

- [ ] **Step 8: Checkpoint** — no commit (see Global Constraints).

---

### Task 2: Twitch category client

**Files:**
- Create: `apps/backend/src/twitch/categories.ts`
- Test: `apps/backend/src/twitch/categories.test.ts`

**Interfaces:**
- Produces:
  - `interface TwitchGame { id: string; name: string; slug: string; boxArtUrl: string | null }`
  - `twitchGames(fetchImpl?: typeof fetch): TwitchGames`
  - `TwitchGames = { search(text, first?): Promise<TwitchGame[]>; byId(id): Promise<TwitchGame | null>; find(query): Promise<TwitchGame[]> }`
  - All three throw on transport or GQL failure.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test, vi } from "vitest";
import { twitchGames } from "./categories.js";

const node = (id: string, name: string) => ({
  id, displayName: name, slug: name.toLowerCase().replace(/\s+/g, "-"),
  boxArtURL: `https://static-cdn.jtvnw.net/ttv-boxart/${id}_IGDB-144x192.jpg`,
});

/** A fetch that answers each GQL body with `reply(body)`. */
function stub(reply: (body: { query: string; variables: Record<string, unknown> }) => unknown,
              init: { status?: number } = {}) {
  return vi.fn(async (_url: string | URL | Request, req?: RequestInit) => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => reply(JSON.parse(String(req?.body))),
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

test("search parses Twitch's category nodes", async () => {
  const fetchImpl = stub(() => ({ data: { searchCategories: { edges: [
    { node: node("512953", "ELDEN RING") },
  ] } } }));
  expect(await twitchGames(fetchImpl).search("elden")).toEqual([{
    id: "512953", name: "ELDEN RING", slug: "elden-ring",
    boxArtUrl: "https://static-cdn.jtvnw.net/ttv-boxart/512953_IGDB-144x192.jpg",
  }]);
});

test("the search text travels as a variable, never inside the query", async () => {
  // Review Focus #1: a quote or brace in a game name must not break the query.
  const fetchImpl = stub(() => ({ data: { searchCategories: { edges: [] } } }));
  const text = "Tom Clancy's \"Rainbow\" }{";
  await twitchGames(fetchImpl).search(text);
  const [, req] = fetchImpl.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(String(req.body));
  expect(body.variables.q).toBe(text);
  expect(body.query).not.toContain("Rainbow");
  expect((req.headers as Record<string, string>)["Client-Id"])
    .toBe("kimne78kx3ncx6brgo4mv6wki5h1ko");
});

test("byId returns null for an id Twitch does not know", async () => {
  const fetchImpl = stub(() => ({ data: { game: null } }));
  expect(await twitchGames(fetchImpl).byId("999999999999")).toBeNull();
});

test("a GQL error throws rather than reading as no results", async () => {
  const fetchImpl = stub(() => ({ errors: [{ message: "service timeout" }] }));
  await expect(twitchGames(fetchImpl).search("rust")).rejects.toThrow(/service timeout/);
});

test("a non-200 answer throws", async () => {
  const fetchImpl = stub(() => ({}), { status: 503 });
  await expect(twitchGames(fetchImpl).byId("1")).rejects.toThrow(/503/);
});

test("find skips Twitch for queries under two characters", async () => {
  const fetchImpl = stub(() => ({ data: {} }));
  expect(await twitchGames(fetchImpl).find("  e ")).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("find puts an id match first and does not list it twice", async () => {
  const fetchImpl = stub((body) => body.query.includes("game(id")
    ? { data: { game: node("512953", "ELDEN RING") } }
    : { data: { searchCategories: { edges: [
        { node: node("5129530", "Some Other Game") },
        { node: node("512953", "ELDEN RING") },
      ] } } });
  const found = await twitchGames(fetchImpl).find("512953");
  expect(found.map((g) => g.id)).toEqual(["512953", "5129530"]);
});

test("find asks only the search for a non-numeric query", async () => {
  const fetchImpl = stub(() => ({ data: { searchCategories: { edges: [] } } }));
  await twitchGames(fetchImpl).find("rust");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/twitch/categories.test.ts`
Expected: FAIL with "Cannot find module './categories.js'".

- [ ] **Step 3: Implement**

```ts
/**
 * Twitch's category catalogue: search, and lookup by id.
 *
 * Plain GQL queries against the public endpoint with the web client id.
 * They need no session and no persisted-query hash, so they keep working
 * while the account is signed out and cannot be broken by Twitch
 * rotating hashes. Runs here rather than in the Python helper, which
 * serves one request at a time: typing into the search would otherwise
 * wait behind a directory lookup that takes seconds.
 */

const GQL_URL = "https://gql.twitch.tv/gql";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const TIMEOUT_MS = 5_000;
const MAX_RESULTS = 10;
const FIELDS = "id displayName slug boxArtURL(width: 144, height: 192)";

export interface TwitchGame {
  /** Twitch game id; the same id the campaign catalogue carries. */
  id: string;
  name: string;
  slug: string;
  boxArtUrl: string | null;
}

interface GameNode {
  id?: unknown;
  displayName?: unknown;
  slug?: unknown;
  boxArtURL?: unknown;
}

function toGame(node: GameNode | null | undefined): TwitchGame | null {
  if (node == null || typeof node.id !== "string"
      || typeof node.displayName !== "string" || node.displayName === "") {
    return null;
  }
  return {
    id: node.id,
    name: node.displayName,
    slug: typeof node.slug === "string" ? node.slug : "",
    boxArtUrl: typeof node.boxArtURL === "string" && node.boxArtURL !== ""
      ? node.boxArtURL
      : null,
  };
}

export function twitchGames(fetchImpl: typeof fetch = fetch) {
  /** Throws on any failure: an empty answer must only ever mean "no match". */
  async function query<T>(text: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(GQL_URL, {
      method: "POST",
      headers: { "Client-Id": CLIENT_ID, "Content-Type": "application/json" },
      body: JSON.stringify({ query: text, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Twitch returned HTTP ${res.status}`);
    const payload = await res.json() as { data?: T; errors?: Array<{ message?: string }> };
    if (payload.errors !== undefined && payload.errors.length > 0) {
      throw new Error(`Twitch: ${payload.errors[0]?.message ?? "query failed"}`);
    }
    if (payload.data === undefined || payload.data === null) {
      throw new Error("Twitch returned no data");
    }
    return payload.data;
  }

  async function search(text: string, first = MAX_RESULTS): Promise<TwitchGame[]> {
    const data = await query<{
      searchCategories: { edges?: Array<{ node?: GameNode }> } | null;
    }>(
      `query($q: String!, $first: Int!) { searchCategories(query: $q, first: $first) { edges { node { ${FIELDS} } } } }`,
      { q: text, first },
    );
    return (data.searchCategories?.edges ?? [])
      .map((e) => toGame(e.node))
      .filter((g): g is TwitchGame => g !== null);
  }

  async function byId(id: string): Promise<TwitchGame | null> {
    const data = await query<{ game: GameNode | null }>(
      `query($id: ID!) { game(id: $id) { ${FIELDS} } }`,
      { id },
    );
    return toGame(data.game);
  }

  /**
   * What the Follow dialog shows for a query.
   *
   * An all-digit query is also tried as a game id, first, so a pasted
   * Twitch id finds its game even when the name search would not.
   */
  async function find(raw: string): Promise<TwitchGame[]> {
    const text = raw.trim();
    if (text.length < 2) return [];
    const [exact, found] = await Promise.all([
      /^\d+$/.test(text) ? byId(text) : Promise.resolve(null),
      search(text, MAX_RESULTS),
    ]);
    const rest = found.filter((g) => g.id !== exact?.id);
    return (exact === null ? rest : [exact, ...rest]).slice(0, MAX_RESULTS);
  }

  return { search, byId, find };
}

export type TwitchGames = ReturnType<typeof twitchGames>;
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @app/backend exec vitest run src/twitch/categories.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 3: The follow step as pure functions

**Files:**
- Create: `apps/backend/src/drops/follow.ts`
- Test: `apps/backend/src/drops/follow.test.ts`

**Interfaces:**
- Consumes: `FollowedGame`, `Subscription`, `AppConfig` (Task 1); `resolveCampaign` from `state/dropState.ts`.
- Produces:
  - `followGames(config, catalogue, inventory, now, newId): FollowResult`
  - `FollowResult = { added: FollowedAddition[]; followedGames: FollowedGame[]; changed: boolean }`
  - `FollowedAddition = { subscription: Subscription; game: FollowedGame; campaign: Campaign }`
  - `recordSkipped(games, leaving, gameOfCampaign?): FollowedGame[]`

- [ ] **Step 1: Write the failing tests**

```ts
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
  const inv: InventorySnapshot = {
    progress: { c1: { "c1-d1": { minutes: 60, claimed: true, instanceId: null } } },
    earned: {}, fetchedAt: 1, available: true,
  } as never;
  expect(run(config(), catalogue([campaign("c1")]), inv).added).toEqual([]);
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
  // Review Focus #5: ranks can have gaps after removals; never reuse one.
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/drops/follow.test.ts`
Expected: FAIL with "Cannot find module './follow.js'".

- [ ] **Step 3: Implement**

```ts
import type { AppConfig, FollowedGame, Subscription } from "../config/schema.js";
import type { Campaign, Catalogue } from "../state/campaignCatalogue.js";
import { resolveCampaign } from "../state/dropState.js";
import type { InventorySnapshot } from "../state/inventory.js";

/** A campaign subscription a followed game has just added. */
export interface FollowedAddition {
  subscription: Subscription;
  game: FollowedGame;
  campaign: Campaign;
}

export interface FollowResult {
  added: FollowedAddition[];
  /** The followed games with `skipped` pruned; the same objects when unchanged. */
  followedGames: FollowedGame[];
  /** Whether anything here differs from the config passed in. */
  changed: boolean;
}

/**
 * Progress we could not read. Completion is unknown then, so nothing is
 * held back as complete -- the engine removes it once progress says so.
 */
const UNREAD: InventorySnapshot = { progress: {}, earned: {}, fetchedAt: 0, available: false };

/**
 * Which catalogue campaigns the followed games subscribe to now.
 *
 * Pure: the engine applies the result in its own single write. A
 * campaign is added when its game is followed and it is not already
 * subscribed, not skipped, not over, not already complete, and has at
 * least one drop watching can earn -- adding one that fails the last two
 * would only have the engine remove it again on the same pass.
 *
 * Nothing is added from an unavailable catalogue. A stale one still
 * adds: its end dates are still true, and they filter out what is over.
 * Only a fresh one prunes `skipped`, since only it can say a campaign is
 * gone.
 */
export function followGames(
  config: Pick<AppConfig, "subscriptions" | "followedGames">,
  catalogue: Pick<Catalogue, "campaigns" | "available" | "stale">,
  inventory: InventorySnapshot | null,
  now: number,
  newId: () => string,
): FollowResult {
  if (config.followedGames.length === 0 || !catalogue.available) {
    return { added: [], followedGames: config.followedGames, changed: false };
  }
  const listed = new Set(catalogue.campaigns.map((c) => c.id));
  const subscribed = new Set(config.subscriptions.map((s) => s.targetId));
  // After the highest rank rather than the count: removals leave gaps,
  // and a count can land on a rank already taken.
  let rank = config.subscriptions.reduce((max, s) => Math.max(max, s.rank), -1);
  const added: FollowedAddition[] = [];
  let pruned = false;

  const followedGames = config.followedGames.map((game) => {
    let skipped = game.skipped;
    if (!catalogue.stale) {
      const kept = game.skipped.filter((id) => listed.has(id));
      if (kept.length !== game.skipped.length) {
        skipped = kept;
        pruned = true;
      }
    }
    for (const campaign of catalogue.campaigns) {
      if (campaign.game?.id !== game.id) continue;
      if (subscribed.has(campaign.id) || skipped.includes(campaign.id)) continue;
      if (campaign.endsAt !== null && campaign.endsAt <= now) continue;
      const resolved = resolveCampaign(campaign, inventory ?? UNREAD);
      if (resolved.complete) continue;
      if (!resolved.drops.some((d) => d.status !== "unobtainable")) continue;
      subscribed.add(campaign.id);
      added.push({
        game,
        campaign,
        subscription: {
          id: newId(),
          targetId: campaign.id,
          label: campaign.name,
          poolSize: game.poolSize,
          rank: ++rank,
          viaGame: game.id,
        },
      });
    }
    return skipped === game.skipped ? game : { ...game, skipped };
  });

  return { added, followedGames, changed: pruned || added.length > 0 };
}

/**
 * The followed games with each leaving subscription's campaign skipped.
 *
 * Filed under the game that added it, or -- for one added by hand --
 * under the followed game its campaign belongs to, when
 * `gameOfCampaign` can say. Either way the game will not add it back.
 */
export function recordSkipped(
  games: FollowedGame[],
  leaving: readonly Subscription[],
  gameOfCampaign: (campaignId: string) => string | undefined = () => undefined,
): FollowedGame[] {
  return games.map((game) => {
    const ids = leaving
      .filter((s) => (s.viaGame ?? gameOfCampaign(s.targetId)) === game.id)
      .map((s) => s.targetId)
      .filter((id) => !game.skipped.includes(id));
    return ids.length === 0 ? game : { ...game, skipped: [...game.skipped, ...ids] };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @app/backend exec vitest run src/drops/follow.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 4: The engine runs the follow step

**Files:**
- Modify: `apps/backend/src/drops/engine.ts`
- Modify: `apps/backend/src/appLog/types.ts:42` (after `SUBSCRIPTION_OPENED`)
- Test: `apps/backend/src/drops/engine.test.ts`

**Interfaces:**
- Consumes: `followGames`, `recordSkipped` (Task 3).
- Produces:
  - `PassTrigger` gains `"follow"`.
  - `EngineDeps.onCampaignFollowed?: (e: CampaignFollowed) => void`
  - `EngineDeps.newId?: () => string`
  - `export interface CampaignFollowed { subscriptionId: string; label: string; targetId: string; game: string }`
  - `EVENT.SUBSCRIPTION_FOLLOWED = "subscription.followed"`

- [ ] **Step 1: Write the failing tests**

Extend `make()` in `engine.test.ts`: add the options `onCampaignFollowed?: (e: unknown) => void;` and `newId?: () => string;` to its parameter type, and pass `onCampaignFollowed: over.onCampaignFollowed, newId: over.newId ?? (() => "new-1"),` to the engine. Then append:

```ts
// --- followed games ---

const watchable = { id: "d1", name: "Crate", benefits: [], requiredMinutes: 60, requiredSubs: 0 };
const followed = (over: object = {}) => ({
  id: "g1", name: "A Game", slug: "a-game", boxArtUrl: null,
  poolSize: 1, skipped: [] as string[], ...over,
});

test("a followed game's campaign is subscribed and resolved in the same pass", async () => {
  const { engine, saveConfig, propose } = make({
    config: { streamers: [], subscriptions: [], followedGames: [followed()] } as never,
    catalogue: { campaigns: [campaign({ drops: [watchable] })] },
  });
  await engine.pass("timer");
  const out = written(saveConfig);
  expect(out.subscriptions).toEqual([{
    id: "new-1", targetId: "c1", label: "Alpha", poolSize: 1, rank: 0, viaGame: "g1",
  }]);
  expect(out.streamers.map((s) => [s.username, s.ownedBy])).toEqual([["beta", "new-1"]]);
  expect(propose).toHaveBeenCalledTimes(1);
});

test("adding only a campaign not open yet saves without proposing a restart", async () => {
  const { engine, saveConfig, propose } = make({
    now: 1_000,
    config: { streamers: [], subscriptions: [], followedGames: [followed()] } as never,
    catalogue: { campaigns: [campaign({ startsAt: 5_000, endsAt: 9_000, drops: [watchable] })] },
  });
  await engine.pass("timer");
  expect(written(saveConfig).subscriptions.map((s) => s.targetId)).toEqual(["c1"]);
  expect(propose).not.toHaveBeenCalled();
});

test("a campaign added by a game that ends is skipped from then on", async () => {
  const { engine, saveConfig } = make({
    now: 5_000,
    config: {
      subscriptions: [sub({ viaGame: "g1" })],
      followedGames: [followed()],
    } as never,
    catalogue: { campaigns: [campaign({ endsAt: 4_000, drops: [watchable] })] },
  });
  await engine.pass("timer");
  const out = written(saveConfig);
  expect(out.subscriptions).toEqual([]);
  expect(out.followedGames[0]?.skipped).toEqual(["c1"]);
});

test("a campaign added by a game that completes is skipped from then on", async () => {
  const { engine, saveConfig } = make({
    config: {
      subscriptions: [sub({ viaGame: "g1" })],
      followedGames: [followed()],
    } as never,
    catalogue: { campaigns: [campaign({ drops: [watchable] })] },
    inventory: { progress: { c1: { d1: { minutes: 60, claimed: true, instanceId: null } } } as never },
  });
  await engine.pass("timer");
  expect(written(saveConfig).followedGames[0]?.skipped).toEqual(["c1"]);
});

test("a hand-added campaign of a followed game that completes is skipped too", async () => {
  const { engine, saveConfig } = make({
    config: { subscriptions: [sub()], followedGames: [followed()] } as never,
    catalogue: { campaigns: [campaign({ drops: [watchable] })] },
    inventory: { progress: { c1: { d1: { minutes: 60, claimed: true, instanceId: null } } } as never },
  });
  await engine.pass("timer");
  expect(written(saveConfig).followedGames[0]?.skipped).toEqual(["c1"]);
});

test("the followed notice fires on timer and boot passes only", async () => {
  for (const [trigger, expected] of [
    ["timer", 1], ["boot", 1], ["follow", 0], ["manual", 0], ["subscribe", 0],
  ] as const) {
    const told = vi.fn();
    const { engine } = make({
      config: { streamers: [], subscriptions: [], followedGames: [followed()] } as never,
      catalogue: { campaigns: [campaign({ drops: [watchable] })] },
      onCampaignFollowed: told,
    });
    await engine.pass(trigger);
    expect(told, trigger).toHaveBeenCalledTimes(expected);
    if (expected === 1) {
      expect(told).toHaveBeenCalledWith({
        subscriptionId: "new-1", label: "Alpha", targetId: "c1", game: "A Game",
      });
    }
  }
});

test("followed games with nothing to add write nothing", async () => {
  const { engine, saveConfig } = make({
    config: { streamers: [], subscriptions: [], followedGames: [followed()] } as never,
    catalogue: { campaigns: [] },
  });
  await engine.pass("timer");
  expect(saveConfig).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/drops/engine.test.ts`
Expected: the new tests FAIL. The pass returns early with no subscriptions, and `onCampaignFollowed` is never called.

- [ ] **Step 3: Implement**

`apps/backend/src/appLog/types.ts`, after `SUBSCRIPTION_OPENED`:

```ts
  /** A followed game's campaign was subscribed to automatically. */
  SUBSCRIPTION_FOLLOWED: "subscription.followed",
```

`apps/backend/src/drops/engine.ts`:

- Imports: add `import { randomUUID } from "node:crypto";` and `import { followGames, recordSkipped } from "./follow.js";`.
- After `CampaignStart`, add:

  ```ts
  /** A campaign a followed game subscribed to, for notifications. */
  export interface CampaignFollowed {
    subscriptionId: string;
    label: string;
    targetId: string;
    /** The followed game's name. */
    game: string;
  }
  ```

- In `EngineDeps`, add:

  ```ts
    /**
     * Told when a followed game subscribes to a campaign, on passes the
     * user did not start -- one they started already shows the result.
     */
    onCampaignFollowed?: (event: CampaignFollowed) => void;
    /** New subscription ids. Injectable so tests get stable ones. */
    newId?: () => string;
  ```

- In `PassTrigger`, add `| "follow"`.
- Replace the start of `pass()` up to and including `const ordered = …`:

  ```ts
    async pass(trigger: PassTrigger = "manual"): Promise<void> {
      const loaded = this.deps.loadConfig();
      if (loaded.subscriptions.length === 0 && loaded.followedGames.length === 0) {
        this.scheduled.clear();
        return;
      }

      this.log.debug({
        type: EVENT.PASS_START,
        msg: `resolving ${loaded.subscriptions.length} subscription(s) (${trigger})`,
        subscriptions: loaded.subscriptions.length,
        trigger,
      });

      const catalogue = await this.deps.catalogue.get();
      const byId = new Map(catalogue.campaigns.map((c) => [c.id, c]));
      // Only a catalogue we actually read can tell us a campaign is gone.
      const trustworthy = catalogue.available && !catalogue.stale;
      const now = this.deps.now?.() ?? Date.now();
      // InventoryCache.get() never rejects.
      const inventory = this.deps.inventory !== undefined
        ? await this.deps.inventory.get()
        : null;

      // Before anything else, so a campaign a followed game adds gets its
      // channels on this same pass.
      const follow = followGames(
        loaded, catalogue, inventory, now, this.deps.newId ?? randomUUID,
      );
      const config = follow.changed
        ? {
          ...loaded,
          followedGames: follow.followedGames,
          subscriptions: [...loaded.subscriptions, ...follow.added.map((a) => a.subscription)],
        }
        : loaded;
      for (const { subscription, game } of follow.added) {
        this.log.info({
          type: EVENT.SUBSCRIPTION_FOLLOWED,
          msg: `"${subscription.label}" is a campaign for followed game "${game.name}", `
            + "so it was subscribed to",
          subscriptionId: subscription.id,
          label: subscription.label,
          targetId: subscription.targetId,
          game: game.name,
        });
      }

      // Rank order: lower ranks fill the miner's watch slots first, and
      // the written order is what upstream's priority_order consumes.
      const ordered = [...config.subscriptions].sort((a, b) => a.rank - b.rank);
  ```

- Replace everything from `const { streamers, changed, added, removed } = reconcile(` to the end of `pass()`:

  ```ts
      const { streamers, changed, added, removed } = reconcile(config.streamers, desired);
      // A leaving campaign of a followed game is filed as skipped, so the
      // game does not add it back while it is still listed -- say on a
      // pass where progress could not be read to show it complete.
      const followedGames = ended.size === 0
        ? config.followedGames
        : recordSkipped(
          config.followedGames,
          ordered.filter((s) => ended.has(s.id)),
          (id) => byId.get(id)?.game?.id,
        );
      if (!changed && ended.size === 0 && !follow.changed) {
        // The common case by design, and deliberately debug: a healthy
        // quarter-hour where nothing needed doing should not fill the log.
        this.log.debug({
          type: EVENT.PASS_NOOP,
          msg: "the resolve pass changed nothing; no restart needed",
          trigger,
        });
        return;
      }

      if (changed || ended.size > 0) {
        this.log.info({
          type: EVENT.RECONCILED,
          msg: added.length === 0 && removed.length === 0
            ? `the watch list was reordered (${streamers.length} channel(s))`
            : `the watch list changed: +${added.length} -${removed.length}`,
          added,
          removed,
          changed,
          endedSubscriptions: ended.size,
          trigger,
        });
      }

      this.deps.saveConfig(this.deps.configPath, {
        ...config,
        streamers,
        subscriptions: config.subscriptions.filter((s) => !ended.has(s.id)),
        followedGames,
      });
      if (trigger === "timer" || trigger === "boot") {
        for (const { subscription, game } of follow.added) {
          this.deps.onCampaignFollowed?.({
            subscriptionId: subscription.id,
            label: subscription.label,
            targetId: subscription.targetId,
            game: game.name,
          });
        }
      }
      // Only a different watch list needs the miner restarted; a campaign
      // added but not open yet changes nothing it can see.
      if (!changed && ended.size === 0) return;
      // The boot pass runs before the miner starts, which then reads what
      // was just written -- a restart would only repeat that start. Unless
      // it ran past its budget and the miner started without it.
      if (trigger === "boot" && !this.bootLate) return;
      this.deps.pending.propose(
        ended.size > 0
          ? "a drop campaign ended or completed"
          : "drop subscriptions resolved new channels",
      );
    }
  ```

- [ ] **Step 4: Run the engine tests and the type check**

Run: `pnpm --filter @app/backend exec vitest run src/drops && pnpm run build:backend`
Expected: all PASS, `tsc` exits 0.

- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 5: Followed-games API routes

**Files:**
- Modify: `apps/backend/src/http/server.ts` (ServerDeps, `GET /api/subscriptions`, `POST /api/subscriptions/:id/remove`, new routes after `/api/subscriptions/queue`)
- Modify: `apps/backend/src/appLog/types.ts:73` (after `USER_SUB_QUEUE`)
- Modify: `apps/backend/src/index.ts` (pass `games` to `buildServer`)
- Test: `apps/backend/src/http/server.test.ts`

**Interfaces:**
- Consumes:
  - `TwitchGames`, `TwitchGame` (Task 2)
  - `recordSkipped` (Task 3)
  - `followedGameSchema` (Task 1)
  - the `"follow"` trigger (Task 4)
- Produces (HTTP):
  - `GET /api/games/search?q=` → `{ games: TwitchGame[] }` | `502 { error }`
  - `POST /api/followed-games { ids }` → `{ added: TwitchGame[]; alreadyFollowed: string[]; notFound: string[] }`
  - `POST /api/followed-games/:id/pool-size { poolSize }` → `{ game: FollowedGame }`
  - `POST /api/followed-games/:id/remove` → `{ ok: true }`
  - `GET /api/subscriptions` gains `followedGames: FollowedGame[]`
- Produces (TS): `ServerDeps.games: Pick<TwitchGames, "find" | "byId">`

- [ ] **Step 1: Write the failing tests**

In `make()` in `server.test.ts`:
- add `import type { TwitchGame } from "../twitch/categories.js";`
- add `const games = { find: vi.fn(async (_q: string): Promise<TwitchGame[]> => []), byId: vi.fn(async (_id: string): Promise<TwitchGame | null> => null) };`
- pass `games,` to `buildServer`, and add `games` to the returned object.

Then append:

```ts
// --- followed games ---

const elden = {
  id: "512953", name: "ELDEN RING", slug: "elden-ring",
  boxArtUrl: "https://static-cdn.jtvnw.net/ttv-boxart/512953_IGDB-144x192.jpg",
};
const asFollowed = (over: object = {}) => ({ ...elden, poolSize: 3, skipped: [], ...over });
const withFollowed = (followedGames: unknown[], subscriptions: unknown[] = []) => {
  saveConfig(ctx.configPath, {
    ...loadConfig(ctx.configPath), subscriptions, followedGames,
  } as never);
};

test("GET /api/games/search returns what Twitch found", async () => {
  ctx.games.find.mockResolvedValueOnce([elden]);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/games/search?q=elden", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ games: [elden] });
  expect(ctx.games.find).toHaveBeenCalledWith("elden");
});

test("GET /api/games/search answers 502 when Twitch fails, never an empty list", async () => {
  ctx.games.find.mockRejectedValueOnce(new Error("Twitch returned HTTP 503"));
  const res = await ctx.app.inject({
    method: "GET", url: "/api/games/search?q=elden", cookies: auth(),
  });
  expect(res.statusCode).toBe(502);
  expect(res.json().error).toMatch(/503/);
});

test("POST /api/followed-games stores what Twitch returned and resolves", async () => {
  withFollowed([]);
  ctx.games.byId.mockResolvedValueOnce(elden);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/followed-games", cookies: auth(),
    payload: { ids: ["512953"] },
  });
  expect(res.json()).toEqual({ added: [elden], alreadyFollowed: [], notFound: [] });
  expect(loadConfig(ctx.configPath).followedGames).toEqual([asFollowed()]);
  expect(ctx.engine.pass).toHaveBeenCalledWith("follow");
});

test("a mixed follow batch reports each id", async () => {
  withFollowed([asFollowed()]);
  ctx.games.byId.mockImplementation(async (id) => (id === "263490"
    ? { id: "263490", name: "Rust", slug: "rust", boxArtUrl: null }
    : null));
  const res = await ctx.app.inject({
    method: "POST", url: "/api/followed-games", cookies: auth(),
    payload: { ids: ["512953", "263490", "404"] },
  });
  expect(res.json()).toEqual({
    added: [{ id: "263490", name: "Rust", slug: "rust", boxArtUrl: null }],
    alreadyFollowed: ["512953"],
    notFound: ["404"],
  });
  expect(loadConfig(ctx.configPath).followedGames.map((g) => g.id))
    .toEqual(["512953", "263490"]);
});

test("the same id twice in one request is looked up and followed once", async () => {
  // Review Focus #2.
  withFollowed([]);
  ctx.games.byId.mockResolvedValue(elden);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/followed-games", cookies: auth(),
    payload: { ids: ["512953", "512953"] },
  });
  expect(res.json().added).toHaveLength(1);
  expect(ctx.games.byId).toHaveBeenCalledTimes(1);
  expect(loadConfig(ctx.configPath).followedGames).toHaveLength(1);
});

test("a Twitch failure while following saves nothing", async () => {
  withFollowed([]);
  ctx.games.byId.mockRejectedValueOnce(new Error("timeout"));
  const res = await ctx.app.inject({
    method: "POST", url: "/api/followed-games", cookies: auth(),
    payload: { ids: ["512953"] },
  });
  expect(res.statusCode).toBe(502);
  expect(loadConfig(ctx.configPath).followedGames).toEqual([]);
  expect(ctx.engine.pass).not.toHaveBeenCalled();
});

test("POST /api/followed-games wants 1-25 ids", async () => {
  for (const ids of [undefined, [], Array.from({ length: 26 }, (_, i) => String(i)), [""], [7]]) {
    const res = await ctx.app.inject({
      method: "POST", url: "/api/followed-games", cookies: auth(), payload: { ids },
    });
    expect(res.statusCode, JSON.stringify(ids)).toBe(400);
  }
});

test("a followed game's pool size can be changed", async () => {
  withFollowed([asFollowed()]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/followed-games/512953/pool-size", cookies: auth(),
    payload: { poolSize: 5 },
  });
  expect(res.json().game.poolSize).toBe(5);
  expect(loadConfig(ctx.configPath).followedGames[0]?.poolSize).toBe(5);
  const bad = await ctx.app.inject({
    method: "POST", url: "/api/followed-games/512953/pool-size", cookies: auth(),
    payload: { poolSize: 11 },
  });
  expect(bad.statusCode).toBe(400);
  const missing = await ctx.app.inject({
    method: "POST", url: "/api/followed-games/1/pool-size", cookies: auth(),
    payload: { poolSize: 2 },
  });
  expect(missing.statusCode).toBe(404);
});

test("unfollowing keeps the campaign subscriptions the game added", async () => {
  withFollowed([asFollowed()], [aSub({ viaGame: "512953" })]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/followed-games/512953/remove", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  const config = loadConfig(ctx.configPath);
  expect(config.followedGames).toEqual([]);
  expect(config.subscriptions.map((s) => s.id)).toEqual(["s1"]);
});

test("removing a subscription a game added skips that campaign", async () => {
  withFollowed([asFollowed()], [aSub({ viaGame: "512953" })]);
  await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/s1/remove", cookies: auth(),
  });
  expect(loadConfig(ctx.configPath).followedGames[0]?.skipped).toEqual(["c1"]);
});

test("removing a hand-added subscription for a followed game's campaign skips it too", async () => {
  // Review Focus #3: otherwise the game adds it straight back.
  ctx.setCampaigns(() => [{
    ...aCampaign, endsAt: Date.now() + 86_400_000,
    game: { id: "512953", slug: "elden-ring", displayName: "ELDEN RING" },
  }]);
  await ctx.catalogue.refresh();
  withFollowed([asFollowed()], [aSub()]);
  await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/s1/remove", cookies: auth(),
  });
  expect(loadConfig(ctx.configPath).followedGames[0]?.skipped).toEqual(["c1"]);
});

test("GET /api/subscriptions includes the followed games", async () => {
  withFollowed([asFollowed()], [aSub({ viaGame: "512953" })]);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/subscriptions", cookies: auth(),
  });
  expect(res.json().followedGames).toEqual([asFollowed()]);
  expect(res.json().subscriptions[0].viaGame).toBe("512953");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/http/server.test.ts -t "followed|games/search|skips"`
Expected: FAIL with 404s from unknown routes, and `skipped` still empty.

- [ ] **Step 3: Implement**

`apps/backend/src/appLog/types.ts`, after `USER_SUB_QUEUE`:

```ts
  USER_GAME_FOLLOWED: "user.game.followed",
  USER_GAME_UNFOLLOWED: "user.game.unfollowed",
  USER_GAME_POOL_SIZE: "user.game.poolSize",
```

`apps/backend/src/http/server.ts`:

- Imports:
  - add `followedGameSchema` to the `../config/schema.js` import;
  - add `import { recordSkipped } from "../drops/follow.js";`;
  - add `import type { TwitchGame, TwitchGames } from "../twitch/categories.js";`.
- In `ServerDeps`, after `engine`:

  ```ts
    /** Twitch's category search and lookup, for following games. */
    games: Pick<TwitchGames, "find" | "byId">;
  ```

- In `GET /api/subscriptions`'s returned object, add `followedGames: config.followedGames,` after `campaignQueue`.
- In `POST /api/subscriptions/:id/remove`, replace the `saveConfig` call:

  ```ts
      const leaving = config.subscriptions.find((s) => s.id === id)!;
      // Skipped under its followed game, so that game does not add it back.
      // A hand-added one is matched through its campaign's game.
      const gameOf = (campaignId: string) =>
        deps.catalogue.peek()?.campaigns.find((c) => c.id === campaignId)?.game?.id;
      saveConfig(deps.configPath, {
        ...config,
        subscriptions: config.subscriptions.filter((s) => s.id !== id),
        streamers: config.streamers.filter((s) => s.ownedBy !== id),
        followedGames: recordSkipped(config.followedGames, [leaving], gameOf),
      });
  ```

- After the `/api/subscriptions/queue` route, add:

  ```ts
      /**
       * Twitch's categories matching what was typed.
       *
       * A failure is a 502, never an empty list: "no such game" and "could
       * not ask" are different answers, and only one is about the game.
       */
      instance.get("/api/games/search", async (request, reply) => {
        const q = (request.query as { q?: unknown }).q;
        try {
          return { games: await deps.games.find(typeof q === "string" ? q : "") };
        } catch (cause) {
          return reply.code(502).send({
            error: `Twitch search is unavailable: ${messageOf(cause)}`,
          });
        }
      });

      /**
       * Follows games by Twitch id.
       *
       * Each id is looked up on Twitch again and what Twitch returns is
       * stored -- that is the validation, and it keeps names and box art
       * from ever being whatever the browser sent. All or nothing on a
       * Twitch failure, so a half-applied batch never needs explaining.
       */
      instance.post("/api/followed-games", async (request, reply) => {
        const ids = (request.body as { ids?: unknown } | null)?.ids;
        const valid = Array.isArray(ids) && ids.length >= 1 && ids.length <= 25
          && ids.every((id) => typeof id === "string" && id !== "");
        if (!valid) {
          return reply.code(400).send({ error: "ids must list 1-25 Twitch game ids" });
        }
        const unique = [...new Set(ids as string[])];
        const before = new Set(loadConfig(deps.configPath).followedGames.map((g) => g.id));
        const alreadyFollowed = unique.filter((id) => before.has(id));
        const wanted = unique.filter((id) => !before.has(id));
        let found: Array<TwitchGame | null>;
        try {
          found = await Promise.all(wanted.map((id) => deps.games.byId(id)));
        } catch (cause) {
          return reply.code(502).send({
            error: `Twitch could not be reached: ${messageOf(cause)}`,
          });
        }
        const notFound = wanted.filter((_, i) => found[i] === null);
        // Re-read: the lookups took time, and a pass may have written since.
        const config = loadConfig(deps.configPath);
        const known = new Set(config.followedGames.map((g) => g.id));
        const added = found.filter((g): g is TwitchGame => g !== null && !known.has(g.id));
        if (added.length > 0) {
          saveConfig(deps.configPath, {
            ...config,
            followedGames: [
              ...config.followedGames,
              ...added.map((g) => followedGameSchema.parse(g)),
            ],
          });
          log.info({
            type: EVENT.USER_GAME_FOLLOWED,
            msg: `followed ${added.map((g) => `"${g.name}"`).join(", ")}`,
            games: added.map((g) => ({ id: g.id, name: g.name })),
          });
          // Subscribes to what is already running now rather than in up to
          // fifteen minutes. Swallowed: the games are saved either way.
          await deps.engine.pass("follow").catch(() => {});
        }
        return { added, alreadyFollowed, notFound };
      });

      /** Pool size for the campaigns this game adds from now on. */
      instance.post("/api/followed-games/:id/pool-size", async (request, reply) => {
        const { id } = request.params as { id: string };
        const config = loadConfig(deps.configPath);
        const current = config.followedGames.find((g) => g.id === id);
        if (current === undefined) {
          return reply.code(404).send({ error: "that game is not followed" });
        }
        const poolSize = followedGameSchema.shape.poolSize
          .safeParse((request.body as { poolSize?: unknown } | null)?.poolSize);
        if (!poolSize.success) {
          return reply.code(400).send({ error: "not a valid pool size" });
        }
        const game = { ...current, poolSize: poolSize.data };
        saveConfig(deps.configPath, {
          ...config,
          followedGames: config.followedGames.map((g) => (g.id === id ? game : g)),
        });
        log.info({
          type: EVENT.USER_GAME_POOL_SIZE,
          msg: `pool size for followed game "${game.name}" set to ${game.poolSize}`,
          gameId: id,
          from: current.poolSize,
          to: game.poolSize,
        });
        return { game };
      });

      /**
       * Stops following a game. The campaign subscriptions it added stay:
       * one may be partway collected, and each can be removed on its own.
       */
      instance.post("/api/followed-games/:id/remove", async (request, reply) => {
        const { id } = request.params as { id: string };
        const config = loadConfig(deps.configPath);
        const game = config.followedGames.find((g) => g.id === id);
        if (game === undefined) {
          return reply.code(404).send({ error: "that game is not followed" });
        }
        saveConfig(deps.configPath, {
          ...config,
          followedGames: config.followedGames.filter((g) => g.id !== id),
        });
        log.info({
          type: EVENT.USER_GAME_UNFOLLOWED,
          msg: `unfollowed "${game.name}"`,
          gameId: id,
        });
        return { ok: true };
      });
  ```

`apps/backend/src/index.ts`: add `import { twitchGames } from "./twitch/categories.js";` and pass `games: twitchGames(),` to `buildServer` next to `engine`.

- [ ] **Step 4: Run the backend suite and the type check**

Run: `pnpm --filter @app/backend test && pnpm run build:backend`
Expected: all PASS, `tsc` exits 0.

- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 6: `campaign.new` moves to the engine hook

**Files:**
- Modify: `apps/backend/src/notify/sources/campaigns.ts`
- Modify: `apps/backend/src/notify/catalogue.ts:97-99`
- Modify: `apps/backend/src/index.ts` (engine deps, CampaignWatcher deps)
- Test: `apps/backend/src/notify/sources/campaigns.test.ts`, `apps/backend/src/notify/catalogue.test.ts`

**Interfaces:**
- Consumes: `CampaignFollowed` (Task 4).
- Produces: `campaignFollowedNotification(e: CampaignFollowed): PublishInput`. `CampaignWatcherDeps` without `subscribedGames`, and with `notifier: Pick<Notifier, "publish" | "markSeen">`.

- [ ] **Step 1: Write the failing tests**

`campaigns.test.ts`:
- import `campaignFollowedNotification` alongside `campaignStartedNotification`;
- change `harness(opts: { wantsNew?: boolean; games?: string[] } = {})` to `harness()`;
- make the notifier `{ publish, markSeen }` and delete the `subscribedGames` line;
- rename the first test to `"completions publish once the watcher is primed"` and change its first line to `const h = harness();`;
- delete `"a new campaign is published only for a subscribed game, never on the first pass"`;
- add:

```ts
test("a campaign a followed game subscribed to reads as what happened", () => {
  expect(campaignFollowedNotification({
    subscriptionId: "s1", label: "Nightreign Drops", targetId: "c9", game: "ELDEN RING",
  })).toEqual({
    kind: "campaign.new", title: "New campaign",
    body: "\"Nightreign Drops\" for ELDEN RING was subscribed automatically.",
    link: "/?open=drops&campaign=c9", dedupeKey: "campaign.new:c9",
  });
});
```

`catalogue.test.ts`: add `"campaign.new"` to the expected list in `"the defaults match the spec"`, after `"campaign.endingSoon"`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/notify`
Expected: FAIL. `campaignFollowedNotification` is not exported, and the defaults list lacks `campaign.new`.

- [ ] **Step 3: Implement**

`campaigns.ts`:
- Import `type CampaignFollowed` next to `CampaignStart`.
- After `campaignStartedNotification`, add:

  ```ts
  export function campaignFollowedNotification(e: CampaignFollowed): PublishInput {
    return {
      kind: NOTIFY_KIND.CAMPAIGN_NEW,
      title: "New campaign",
      body: `"${e.label}" for ${e.game} was subscribed automatically.`,
      link: link(e.targetId),
      dedupeKey: `campaign.new:${e.targetId}`,
    };
  }
  ```

- In `CampaignWatcherDeps`: change to `notifier: Pick<Notifier, "publish" | "markSeen">;` and delete `subscribedGames`.
- Class doc comment: replace it with

  ```ts
  /**
   * Completed and ending-soon campaigns.
   *
   * Covers every campaign with progress, subscribed or not, which is why
   * it watches the inventory itself rather than hooking the engine. Each
   * notification fires once per campaign, via a persisted dedupe key.
   * Both passes always run, even with no destination wanting them: they
   * reach the inbox regardless of push subscriptions, and the Notifier --
   * not this source -- decides who gets pushed.
   */
  ```

- Delete the `known` field, `announceNew()`, and in `run()` the `wantsNew` lines and `if (wantsNew) this.announceNew(…)`. Keep `const { notifier } = this.deps;`.

`catalogue.ts`, the `CAMPAIGN_NEW` entry:

```ts
  { kind: NOTIFY_KIND.CAMPAIGN_NEW, group: "drops", label: "New campaign",
    description: "A campaign for a game you follow was subscribed automatically.",
    defaultOn: true, inbox: true, urgency: "normal", ttlSeconds: DAY_S, batch: false },
```

`index.ts`:
- import `campaignFollowedNotification` next to `campaignStartedNotification`;
- in the `SubscriptionEngine` deps, add `onCampaignFollowed: (event) => notifier.publish(campaignFollowedNotification(event)),`;
- in `new CampaignWatcher({...})`, delete the `subscribedGames` property.

- [ ] **Step 4: Run the backend suite and the type check**

Run: `pnpm --filter @app/backend test && pnpm run build:backend`
Expected: all PASS, `tsc` exits 0.

- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 7: Frontend — drop `kind`, shared types, PoolSizeInput, Auto badge

**Files:**
- Create: `apps/frontend/src/lib/followedGames.ts`
- Create: `apps/frontend/src/lib/followedGames.test.ts`
- Create: `apps/frontend/src/components/PoolSizeInput.tsx`, `apps/frontend/src/components/PoolSizeInput.module.css`
- Modify: `apps/frontend/src/routes/Drops.tsx`, `apps/frontend/src/routes/Drops.module.css:1-41`
- Test: `apps/frontend/src/routes/Drops.test.tsx`

**Interfaces:**
- Produces:
  - `lib/followedGames.ts`:
    - `TwitchGame { id; name; slug; boxArtUrl: string | null }`
    - `FollowedGame extends TwitchGame { poolSize: number; skipped: string[] }`
    - `FollowResponse { added: TwitchGame[]; alreadyFollowed: string[]; notFound: string[] }`
    - `runningCampaigns(gameId, campaigns, now?): number`
    - `followSummary(res, subscribed): string`
    - `viaGameName(viaGame, followed, campaigns): string | null`
  - `PoolSizeInput({ value, label, hint, disabled, onCommit })`
  - `SubscriptionRow` type: no `kind`; adds `viaGame?: string`.

- [ ] **Step 1: Write the failing tests**

`apps/frontend/src/lib/followedGames.test.ts`:

```ts
import { expect, test } from "vitest";
import { followSummary, runningCampaigns, viaGameName } from "./followedGames.js";

const NOW = 10_000;
const c = (id: string, gameId: string | null, endsAt: number | null = NOW + 1) => ({
  id, name: id, game: gameId === null ? null : { id: gameId, slug: gameId, displayName: `Game ${gameId}` },
  startsAt: 1, endsAt, drops: [], status: "untouched", complete: false,
}) as never;

test("runningCampaigns counts a game's campaigns that have not ended", () => {
  expect(runningCampaigns("g1", [c("a", "g1"), c("b", "g1", NOW), c("x", "g2")], NOW)).toBe(1);
});

test("followSummary says what following did", () => {
  const rust = { id: "1", name: "Rust", slug: "rust", boxArtUrl: null };
  expect(followSummary({ added: [rust], alreadyFollowed: [], notFound: [] }, 2))
    .toBe("Following Rust · 2 campaigns subscribed");
  expect(followSummary({ added: [rust, { ...rust, id: "2" }], alreadyFollowed: [], notFound: ["9"] }, 0))
    .toBe("Following 2 games · no campaigns running right now · 1 not found on Twitch");
  expect(followSummary({ added: [], alreadyFollowed: ["1"], notFound: [] }, 0))
    .toBe("Already following");
});

test("viaGameName prefers the followed game, then the catalogue", () => {
  const followed = [{ id: "g1", name: "ELDEN RING", slug: "", boxArtUrl: null, poolSize: 3, skipped: [] }];
  expect(viaGameName("g1", followed, [])).toBe("ELDEN RING");
  expect(viaGameName("g2", followed, [c("a", "g2")])).toBe("Game g2");
  expect(viaGameName("g3", followed, [])).toBeNull();
});
```

In `Drops.test.tsx`:
- In `asSub`, remove `kind: "campaign", `.
- In `withSubs`, add a 4th parameter `followedGames: unknown[] = []`, and return `({ subscriptions, campaignQueue, followedGames })` from the `/api/subscriptions` branch.
- In `"subscribing posts the campaign the button belongs to"`, change the `toMatchObject` argument to `{ targetId: "c2", label: "Beta Campaign" }` and add `expect(JSON.parse(String(post?.init?.body))).not.toHaveProperty("kind");`.
- Delete `"a game subscription for an unknown game gets no link"`, `"a game subscription links to that game's directory"` and `"names the game on a game subscription labelled something else"`.
- Change `"does not repeat the game when it is already the label"` to `withSubs([asSub({ label: "Alpha Game" })]);` and replace its comment with "A campaign named after its game would otherwise read the name twice."
- Add:

```ts
test("a subscription a followed game added carries an Auto badge", async () => {
  withSubs([asSub({ viaGame: "g1" })], { pending: false }, false, [{
    id: "g1", name: "Alpha Game", slug: "alpha-game", boxArtUrl: null, poolSize: 3, skipped: [],
  }]);
  renderApp(<Drops />);
  const row = await screen.findByTestId("subscription-row");
  const badge = within(row).getByTestId("subscription-auto");
  expect(badge.textContent).toBe("Auto");
  await userEvent.hover(badge);
  expect(await screen.findByText(/Added because you follow Alpha Game/)).toBeTruthy();
});

test("a hand-added subscription has no Auto badge", async () => {
  withSubs([asSub()]);
  renderApp(<Drops />);
  const row = await screen.findByTestId("subscription-row");
  expect(within(row).queryByTestId("subscription-auto")).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/frontend exec vitest run src/lib/followedGames.test.ts src/routes/Drops.test.tsx`
Expected: FAIL. The module is missing and no Auto badge renders.

- [ ] **Step 3: Implement**

`apps/frontend/src/lib/followedGames.ts`:

```ts
import type { ResolvedCampaign } from "../components/CampaignCard.js";

/** A Twitch category, as the search and the follow route report it. */
export interface TwitchGame {
  id: string;
  name: string;
  slug: string;
  boxArtUrl: string | null;
}

/** A followed game, as GET /api/subscriptions reports it. */
export interface FollowedGame extends TwitchGame {
  poolSize: number;
  skipped: string[];
}

export interface FollowResponse {
  added: TwitchGame[];
  alreadyFollowed: string[];
  notFound: string[];
}

/** How many of a game's campaigns are listed and not over. */
export function runningCampaigns(
  gameId: string,
  campaigns: readonly ResolvedCampaign[],
  now = Date.now(),
): number {
  return campaigns.filter(
    (c) => c.game?.id === gameId && (c.endsAt === null || c.endsAt > now),
  ).length;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** One line saying what a follow did, for the Followed games card. */
export function followSummary(res: FollowResponse, subscribed: number): string {
  const parts: string[] = [];
  if (res.added.length > 0) {
    parts.push(res.added.length === 1
      ? `Following ${res.added[0]!.name}`
      : `Following ${res.added.length} games`);
    parts.push(subscribed === 0
      ? "no campaigns running right now"
      : `${subscribed} ${plural(subscribed, "campaign", "campaigns")} subscribed`);
  } else if (res.alreadyFollowed.length > 0) {
    parts.push("Already following");
  }
  if (res.notFound.length > 0) parts.push(`${res.notFound.length} not found on Twitch`);
  return parts.join(" · ");
}

/**
 * The name of the game that added a subscription, for its Auto badge.
 *
 * The followed game first; the catalogue when it has since been
 * unfollowed; null when neither knows it.
 */
export function viaGameName(
  viaGame: string,
  followed: readonly FollowedGame[],
  campaigns: readonly ResolvedCampaign[],
): string | null {
  return followed.find((g) => g.id === viaGame)?.name
    ?? campaigns.find((c) => c.game?.id === viaGame)?.game?.displayName
    ?? null;
}
```

`apps/frontend/src/components/PoolSizeInput.module.css`: **move** lines 1-41 of `Drops.module.css` here, unchanged (the comment and the `.poolField`, `.poolInput` and `.poolStepper` rules plus the `@media (hover: none)` block). Delete them from `Drops.module.css`.

`apps/frontend/src/components/PoolSizeInput.tsx`:

```tsx
import { NumberInput, Tooltip } from "@mantine/core";
import { useEffect, useState } from "react";
import classes from "./PoolSizeInput.module.css";

/**
 * A 1-10 channel count, committed on blur or Enter.
 *
 * Held locally so the digits can be edited freely -- half a number is a
 * legal thing to have typed and an illegal thing to save. Committed on
 * blur or Enter rather than per keystroke: a commit can cost a directory
 * resolve and a restart, so typing "6" over "3" must not first ask for a
 * pool of one.
 */
export function PoolSizeInput({ value, label, hint, disabled, onCommit }: {
  value: number;
  /** Accessible name, e.g. "Channels for Rust Drops". */
  label: string;
  /** Why anyone would change it, shown on hover. */
  hint: string;
  disabled: boolean;
  onCommit: (size: number) => void;
}) {
  const [draft, setDraft] = useState<string | number>(value);
  useEffect(() => { setDraft(value); }, [value]);

  function commit() {
    const size = Number(draft);
    // An emptied box is not a request for zero channels; it falls back to
    // the size in force rather than posting something the server rejects.
    if (!Number.isInteger(size) || size < 1 || size > 10) {
      setDraft(value);
      return;
    }
    if (size === value) return;
    onCommit(size);
  }

  return (
    <Tooltip label={hint} multiline w={260}>
      <NumberInput
        size="xs"
        w={48}
        min={1}
        max={10}
        clampBehavior="strict"
        aria-label={label}
        disabled={disabled}
        value={draft}
        onChange={setDraft}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
        classNames={{
          root: classes.poolField,
          input: classes.poolInput,
          controls: classes.poolStepper,
        }}
      />
    </Tooltip>
  );
}
```

`apps/frontend/src/routes/Drops.tsx`:

- Remove `NumberInput` from the Mantine import. Add `import { PoolSizeInput } from "../components/PoolSizeInput.js";` and `import { type FollowedGame, viaGameName } from "../lib/followedGames.js";`.
- `SubscriptionRow` interface:
  - delete `kind`;
  - add after `rank`:

    ```ts
      /** The followed game that added this one, when one did. */
      viaGame?: string;
    ```

  - change the `queue` comment to "Its place in the one-at-a-time queue: null with the queue off. Optional because a backend predating the queue omits it."
- `subscriptionLink`: replace the body with

  ```ts
    const campaign = campaigns.find((c) => c.id === sub.targetId);
    return campaign === undefined
      ? null
      : { href: `#campaign-${campaign.id}`, external: false };
  ```

  Change its return type to `{ href: string; external: boolean } | null` (unchanged). Replace its doc comment with: "Where a subscription's label points: its campaign's card on this page, the only place showing this viewer's progress against its drops. Null once the campaign has left the catalogue."
- `subscriptionGame`: make the lookup `const name = campaigns.find((c) => c.id === sub.targetId)?.game?.displayName;`. Change the doc sentence about game subscriptions to "Null when the name would only repeat the label (a campaign named after its game)".
- `subscriptionOpensAt`: delete `if (sub.kind !== "campaign") return null;`.
- `SubscriptionRow` component:
  - add a prop `auto: { game: string | null } | null;` documented as `/** Set when a followed game added this one; the game's name when known. */`;
  - delete the `draft`/`setDraft`/`useEffect`/`commit` block;
  - replace the `<Tooltip …><NumberInput …/></Tooltip>` with:

    ```tsx
            <PoolSizeInput
              value={sub.poolSize}
              label={`Channels for ${sub.label}`}
              hint={
                "How many channels to keep resolved for this campaign. "
                + "More absorbs channels going offline between checks; "
                + "fewer leaves room for your other subscriptions."
              }
              disabled={busy}
              onCommit={onPoolSize}
            />
    ```

  - right before `{sub.queue == null && opensAt !== null && (`, add:

    ```tsx
              {auto !== null && (
                <Tooltip
                  label={
                    `Added because you follow ${auto.game ?? "this game"}. Removing it `
                    + "skips this campaign; future campaigns for the game are still added."
                  }
                  multiline
                  w={260}
                >
                  <Badge
                    size="xs"
                    variant="light"
                    color="grape"
                    style={{ flexShrink: 0 }}
                    data-testid="subscription-auto"
                  >
                    Auto
                  </Badge>
                </Tooltip>
              )}
    ```

- In `Drops()`:
  - add `const [followed, setFollowed] = useState<FollowedGame[]>([]);` after `subs`;
  - in `loadSubs`, extend the response type with `followedGames?: FollowedGame[];`;
  - after `setSubs(…)`, add `setFollowed(Array.isArray(res.followedGames) ? res.followedGames : []);`.
- In the `<SubscriptionRow` call, add

  ```tsx
                      auto={sub.viaGame === undefined
                        ? null
                        : { game: viaGameName(sub.viaGame, followed, data.campaigns) }}
  ```

- In the Subscriptions tooltip string, delete `+ "Game subscriptions are not queued."` and end the previous string at `"…completes or is removed."`.
- In the campaign grid:
  - `const sub = subs.find((x) => x.targetId === campaign.id);`
  - make the subscribe POST body `{ targetId: campaign.id, label: campaign.name }`.

- [ ] **Step 4: Run the frontend suite and build**

Run: `pnpm --filter @app/frontend test && pnpm --filter @app/frontend exec tsc -b`
Expected: all PASS, `tsc` exits 0.

- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 8: Frontend — Followed games card, search dialog, Drops wiring

**Files:**
- Create: `apps/frontend/src/components/FollowedGamesCard.tsx`
- Create: `apps/frontend/src/components/FollowGamesDialog.tsx`
- Test: `apps/frontend/src/components/FollowedGamesCard.test.tsx`, `apps/frontend/src/components/FollowGamesDialog.test.tsx`
- Modify: `apps/frontend/src/routes/Drops.tsx`
- Test: `apps/frontend/src/routes/Drops.test.tsx`

**Interfaces:**
- Consumes: `TwitchGame`, `FollowedGame`, `FollowResponse`, `runningCampaigns`, `followSummary` (Task 7); `PoolSizeInput` (Task 7); `CampaignBoxArt` (existing).
- Produces:
  - `FollowedGamesCard({ games, campaigns, busy, notice, onAdd, onRemove, onPoolSize })`
  - `FollowGamesDialog({ opened, onClose, followed, campaigns, onConfirm })`, where `onConfirm: (games: TwitchGame[]) => Promise<void>`, and the promise rejects to keep the dialog open with the error shown.
  - In `Drops`: `follow(ids: string[], key: string): Promise<void>`, which Task 9 uses.

- [ ] **Step 1: Write the failing component tests**

`FollowedGamesCard.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { FollowedGamesCard } from "./FollowedGamesCard.js";

const elden = { id: "512953", name: "ELDEN RING", slug: "elden-ring", boxArtUrl: null, poolSize: 3, skipped: [] };
const running = { id: "c1", name: "Nightreign", startsAt: 1, endsAt: Date.now() + 86_400_000,
  game: { id: "512953", slug: "elden-ring", displayName: "ELDEN RING" }, drops: [], status: "untouched" } as never;

const props = (over: object = {}) => ({
  games: [elden], campaigns: [running], busy: false, notice: null,
  onAdd: vi.fn(), onRemove: vi.fn(), onPoolSize: vi.fn(), ...over,
});

test("with nothing followed it explains what following does", () => {
  renderApp(<FollowedGamesCard {...props({ games: [] })} />);
  expect(screen.getByText(/subscribe to its drop campaigns automatically/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /follow games/i })).toBeTruthy();
});

test("a followed game shows its running campaigns and links to Twitch", () => {
  renderApp(<FollowedGamesCard {...props()} />);
  const row = screen.getByTestId("followed-game");
  expect(row.textContent).toMatch(/1 campaign running/);
  expect(within(row).getByRole("link", { name: /ELDEN RING/ }).getAttribute("href"))
    .toBe("https://twitch.tv/directory/category/elden-ring");
});

test("a game with nothing running says so", () => {
  renderApp(<FollowedGamesCard {...props({ campaigns: [] })} />);
  expect(screen.getByTestId("followed-game").textContent).toMatch(/No campaigns right now/);
});

test("remove and pool size report the game", async () => {
  const p = props();
  renderApp(<FollowedGamesCard {...p} />);
  await userEvent.click(screen.getByRole("button", { name: /unfollow ELDEN RING/i }));
  expect(p.onRemove).toHaveBeenCalledWith("512953");
  const input = screen.getByLabelText("Channels for ELDEN RING");
  await userEvent.clear(input);
  await userEvent.type(input, "5{Enter}");
  expect(p.onPoolSize).toHaveBeenCalledWith("512953", 5);
});

test("the notice shows what the last follow did", () => {
  renderApp(<FollowedGamesCard {...props({ notice: "Following Rust · 1 campaign subscribed" })} />);
  expect(screen.getByTestId("follow-notice").textContent).toBe("Following Rust · 1 campaign subscribed");
});
```

`FollowGamesDialog.test.tsx`:

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { FollowGamesDialog } from "./FollowGamesDialog.js";

const game = (id: string, name: string) => ({ id, name, slug: name.toLowerCase(), boxArtUrl: null });
const elden = game("512953", "ELDEN RING");
const rust = game("263490", "Rust");

let searches: string[];
/** Answers /api/games/search from `answer(q)`; a thrown answer is a 502. */
function stubSearch(answer: (q: string) => Promise<unknown> | unknown) {
  searches = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const q = new URL(url, "http://x").searchParams.get("q") ?? "";
    searches.push(q);
    try {
      const games = await answer(q);
      return { ok: true, status: 200, json: async () => ({ games }) };
    } catch {
      return { ok: false, status: 502, json: async () => ({ error: "Twitch search is unavailable" }) };
    }
  }));
}
afterEach(() => { vi.unstubAllGlobals(); });

const open = (over: object = {}) => {
  const onConfirm = vi.fn(async () => {});
  const onClose = vi.fn();
  renderApp(<FollowGamesDialog opened onClose={onClose} followed={[]} campaigns={[]}
    onConfirm={onConfirm} {...over} />);
  return { onConfirm, onClose };
};
const box = () => screen.getByRole("textbox", { name: /search twitch games/i });

test("asks for two characters before searching", async () => {
  stubSearch(() => []);
  open();
  await userEvent.type(box(), "e");
  expect(screen.getByText("Type a game name or Twitch ID")).toBeTruthy();
  await new Promise((r) => setTimeout(r, 350));
  expect(searches).toEqual([]);
});

test("typing quickly sends one search for the final text", async () => {
  stubSearch(() => [elden]);
  open();
  await userEvent.type(box(), "elden");
  await screen.findByText("ELDEN RING");
  expect(searches).toEqual(["elden"]);
});

test("no matches and a failed search read differently", async () => {
  stubSearch((q) => { if (q === "zzz") return []; throw new Error("down"); });
  open();
  await userEvent.type(box(), "zzz");
  expect(await screen.findByText("No matching games")).toBeTruthy();
  await userEvent.clear(box());
  await userEvent.type(box(), "boom");
  expect(await screen.findByText(/Twitch search is unavailable/)).toBeTruthy();
});

test("an older search answering late does not replace a newer one", async () => {
  // Review Focus #4.
  let releaseOld!: () => void;
  stubSearch((q) => q === "ru"
    ? new Promise((r) => { releaseOld = () => r([game("1", "Rusty Lake")]); })
    : [rust]);
  open();
  await userEvent.type(box(), "ru");
  await waitFor(() => expect(searches).toEqual(["ru"]));
  await userEvent.type(box(), "st");
  await screen.findByText("Rust");
  releaseOld();
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText("Rusty Lake")).toBeNull();
});

test("picks survive a second search and are confirmed together", async () => {
  stubSearch((q) => (q.startsWith("eld") ? [elden] : [rust]));
  const { onConfirm, onClose } = open();
  await userEvent.type(box(), "elden");
  await userEvent.click(await screen.findByRole("checkbox", { name: "Follow ELDEN RING" }));
  await userEvent.clear(box());
  await userEvent.type(box(), "rust");
  await userEvent.click(await screen.findByRole("checkbox", { name: "Follow Rust" }));
  expect(within(screen.getByTestId("follow-picked")).getByText("ELDEN RING")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Follow 2 games" }));
  expect(onConfirm).toHaveBeenCalledWith([elden, rust]);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test("a game already followed is shown ticked and cannot be picked again", async () => {
  stubSearch(() => [elden]);
  open({ followed: [{ ...elden, poolSize: 3, skipped: [] }] });
  await userEvent.type(box(), "elden");
  const box1 = await screen.findByRole("checkbox", { name: "Follow ELDEN RING" });
  expect(box1).toBeChecked();
  expect(box1).toBeDisabled();
  expect(screen.getByText("Following")).toBeTruthy();
});

test("a failed follow keeps the dialog open with the reason", async () => {
  stubSearch(() => [elden]);
  const { onClose } = open({ onConfirm: vi.fn(async () => { throw new Error("Twitch could not be reached"); }) });
  await userEvent.type(box(), "elden");
  await userEvent.click(await screen.findByRole("checkbox", { name: "Follow ELDEN RING" }));
  await userEvent.click(screen.getByRole("button", { name: "Follow 1 game" }));
  expect(await screen.findByText(/Twitch could not be reached/)).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/frontend exec vitest run src/components/FollowedGamesCard.test.tsx src/components/FollowGamesDialog.test.tsx`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement the card**

`apps/frontend/src/components/FollowedGamesCard.tsx`:

```tsx
import { Anchor, Button, Card, Group, Stack, Text } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { type FollowedGame, runningCampaigns } from "../lib/followedGames.js";
import { CampaignBoxArt } from "./CampaignBoxArt.js";
import type { ResolvedCampaign } from "./CampaignCard.js";
import { PoolSizeInput } from "./PoolSizeInput.js";

/**
 * The games whose drop campaigns are subscribed to as they appear.
 *
 * Always rendered, even with nothing followed: it is the only way to
 * follow a first game. Rows are not ranked -- a followed game mines
 * nothing itself, its campaigns join the subscription list below.
 */
export function FollowedGamesCard({
  games, campaigns, busy, notice, onAdd, onRemove, onPoolSize,
}: {
  games: FollowedGame[];
  campaigns: ResolvedCampaign[];
  busy: boolean;
  /** What the last follow did, or null. */
  notice: string | null;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onPoolSize: (id: string, size: number) => void;
}) {
  return (
    <Card withBorder padding="sm" data-testid="followed-games">
      <Group justify="space-between" align="center" mb={4}>
        <Text fw={600} size="sm">Followed games</Text>
        <Button
          size="compact-xs"
          leftSection={<IconPlus size={14} />}
          disabled={busy}
          onClick={onAdd}
        >
          Follow games
        </Button>
      </Group>
      {notice !== null && (
        <Text size="xs" c="teal" mb="xs" data-testid="follow-notice">{notice}</Text>
      )}
      {games.length === 0 ? (
        <Text size="xs" c="dimmed">
          Follow a game to subscribe to its drop campaigns automatically as they appear.
        </Text>
      ) : (
        <Stack gap="xs">
          {games.map((game) => {
            const count = runningCampaigns(game.id, campaigns);
            return (
              <Group
                key={game.id}
                justify="space-between"
                wrap="wrap"
                gap="xs"
                data-testid="followed-game"
              >
                <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: "1 1 220px" }}>
                  <CampaignBoxArt url={game.boxArtUrl} displayName={game.name} width={30} />
                  <div style={{ minWidth: 0 }}>
                    {game.slug === "" ? (
                      <Text size="sm" lineClamp={1}>{game.name}</Text>
                    ) : (
                      <Anchor
                        size="sm"
                        lineClamp={1}
                        href={`https://twitch.tv/directory/category/${game.slug}`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {game.name}
                      </Anchor>
                    )}
                    <Text size="xs" c="dimmed">
                      {count === 0
                        ? "No campaigns right now"
                        : count === 1 ? "1 campaign running" : `${count} campaigns running`}
                    </Text>
                  </div>
                </Group>
                <Group gap={6} wrap="nowrap">
                  <PoolSizeInput
                    value={game.poolSize}
                    label={`Channels for ${game.name}`}
                    hint={
                      "How many channels to keep for each campaign this game "
                      + "subscribes to. Applies to campaigns added from now on."
                    }
                    disabled={busy}
                    onCommit={(size) => onPoolSize(game.id, size)}
                  />
                  <Text size="xs" c="dimmed">channels</Text>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    aria-label={`Unfollow ${game.name}`}
                    loading={busy}
                    onClick={() => onRemove(game.id)}
                  >
                    Remove
                  </Button>
                </Group>
              </Group>
            );
          })}
        </Stack>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Implement the dialog**

`apps/frontend/src/components/FollowGamesDialog.tsx`:

```tsx
import {
  Alert, Badge, Button, Checkbox, Group, Loader, Modal, Pill, ScrollArea, Stack, Text, TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { type FollowedGame, type TwitchGame, runningCampaigns } from "../lib/followedGames.js";
import { CampaignBoxArt } from "./CampaignBoxArt.js";
import type { ResolvedCampaign } from "./CampaignCard.js";

type Search =
  | { state: "short" }
  | { state: "loading" }
  | { state: "error" }
  | { state: "done"; games: TwitchGame[] };

const confirmLabel = (n: number) =>
  n === 0 ? "Follow games" : n === 1 ? "Follow 1 game" : `Follow ${n} games`;

/**
 * Searches Twitch's categories and follows the ticked ones.
 *
 * Picks are kept across searches, so several games can be gathered from
 * different queries and followed at once. "No matches" and "search
 * failed" are separate states: presenting a failure as no matches would
 * tell the user a game does not exist.
 */
export function FollowGamesDialog({ opened, onClose, followed, campaigns, onConfirm }: {
  opened: boolean;
  onClose: () => void;
  followed: FollowedGame[];
  campaigns: ResolvedCampaign[];
  /** Rejects to keep the dialog open with the reason shown. */
  onConfirm: (games: TwitchGame[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [debounced] = useDebouncedValue(query.trim(), 300);
  const [search, setSearch] = useState<Search>({ state: "short" });
  const [picked, setPicked] = useState<TwitchGame[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const following = new Set(followed.map((g) => g.id));

  useEffect(() => {
    if (debounced.length < 2) {
      setSearch({ state: "short" });
      return;
    }
    // Dropped when superseded, so a slow older answer cannot replace a
    // newer one.
    let live = true;
    setSearch({ state: "loading" });
    api.get<{ games: TwitchGame[] }>(`/api/games/search?q=${encodeURIComponent(debounced)}`)
      .then((res) => { if (live) setSearch({ state: "done", games: res.games }); })
      .catch(() => { if (live) setSearch({ state: "error" }); });
    return () => { live = false; };
  }, [debounced]);

  function toggle(game: TwitchGame) {
    setPicked((list) => (list.some((g) => g.id === game.id)
      ? list.filter((g) => g.id !== game.id)
      : [...list, game]));
  }

  function close() {
    setQuery("");
    setPicked([]);
    setFailure(null);
    onClose();
  }

  async function confirm() {
    setSaving(true);
    setFailure(null);
    try {
      await onConfirm(picked);
      close();
    } catch (cause: unknown) {
      setFailure(cause instanceof Error ? cause.message : "could not follow those games");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal opened={opened} onClose={close} title="Follow games" size="lg">
      <Stack gap="sm">
        <TextInput
          data-autofocus
          aria-label="Search Twitch games"
          placeholder="Game name or Twitch ID"
          leftSection={<IconSearch size={16} />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        {picked.length > 0 && (
          <Pill.Group data-testid="follow-picked">
            {picked.map((g) => (
              <Pill key={g.id} withRemoveButton onRemove={() => toggle(g)}>{g.name}</Pill>
            ))}
          </Pill.Group>
        )}
        <ScrollArea.Autosize mah={360}>
          {search.state === "short" && (
            <Text size="sm" c="dimmed">Type a game name or Twitch ID</Text>
          )}
          {search.state === "loading" && (
            <Group gap="xs"><Loader size="xs" /><Text size="sm" c="dimmed">Searching Twitch…</Text></Group>
          )}
          {search.state === "error" && (
            <Alert color="yellow">Twitch search is unavailable — try again shortly</Alert>
          )}
          {search.state === "done" && search.games.length === 0 && (
            <Text size="sm" c="dimmed">No matching games</Text>
          )}
          {search.state === "done" && search.games.map((game) => {
            const already = following.has(game.id);
            const count = runningCampaigns(game.id, campaigns);
            return (
              <Group key={game.id} gap="sm" wrap="nowrap" py={4} data-testid="follow-result">
                <Checkbox
                  aria-label={`Follow ${game.name}`}
                  checked={already || picked.some((g) => g.id === game.id)}
                  disabled={already}
                  onChange={() => toggle(game)}
                />
                <CampaignBoxArt url={game.boxArtUrl} displayName={game.name} width={36} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Text size="sm" lineClamp={1}>{game.name}</Text>
                  <Text size="xs" c="dimmed" ff="monospace">{game.id}</Text>
                </div>
                {count > 0 && (
                  <Badge size="xs" variant="light" color="teal">
                    {count === 1 ? "1 campaign" : `${count} campaigns`}
                  </Badge>
                )}
                {already && <Badge size="xs" variant="light" color="gray">Following</Badge>}
              </Group>
            );
          })}
        </ScrollArea.Autosize>
        {failure !== null && <Alert color="red">{failure}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>Cancel</Button>
          <Button
            disabled={picked.length === 0}
            loading={saving}
            onClick={() => void confirm()}
          >
            {confirmLabel(picked.length)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
```

- [ ] **Step 5: Run the component tests**

Run: `pnpm --filter @app/frontend exec vitest run src/components/FollowedGamesCard.test.tsx src/components/FollowGamesDialog.test.tsx`
Expected: PASS (12 tests). If the dialog content isn't found because the Modal transition hasn't finished, add `transitionProps={{ duration: 0 }}` to `<Modal>` rather than changing the tests.

- [ ] **Step 6: Write the failing Drops integration test**

In `Drops.test.tsx`, extend `withSubs`'s stub with two more URL branches, placed *before* the `/api/subscriptions` branch. The shared variables `searchAnswer` and `followAnswer` are declared at module level and reset in `beforeEach`:

```ts
let searchAnswer: unknown = { games: [] };
let followAnswer: unknown = { added: [], alreadyFollowed: [], notFound: [] };
// in beforeEach: searchAnswer = { games: [] }; followAnswer = { added: [], alreadyFollowed: [], notFound: [] };

    if (url.startsWith("/api/games/search")) {
      return { ok: true, status: 200, json: async () => searchAnswer };
    }
    if (url === "/api/followed-games") {
      return { ok: true, status: 200, json: async () => followAnswer };
    }
```

Then add:

```ts
test("the followed games card shows even with nothing subscribed", async () => {
  withSubs([]);
  renderApp(<Drops />);
  expect(await screen.findByTestId("followed-games")).toBeTruthy();
});

test("following from the dialog posts the ids and reports what it did", async () => {
  const alpha = { id: "g1", name: "Alpha Game", slug: "alpha-game", boxArtUrl: null };
  searchAnswer = { games: [alpha] };
  followAnswer = { added: [alpha], alreadyFollowed: [], notFound: [] };
  withSubs([]);
  renderApp(<Drops />);
  await userEvent.click(await screen.findByRole("button", { name: /follow games/i }));
  await userEvent.type(screen.getByRole("textbox", { name: /search twitch games/i }), "alpha");
  await userEvent.click(await screen.findByRole("checkbox", { name: "Follow Alpha Game" }));
  await userEvent.click(screen.getByRole("button", { name: "Follow 1 game" }));
  await waitFor(() => {
    const post = calls.find((c) => c.url === "/api/followed-games");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ ids: ["g1"] });
  });
  expect((await screen.findByTestId("follow-notice")).textContent)
    .toBe("Following Alpha Game · no campaigns running right now");
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @app/frontend exec vitest run src/routes/Drops.test.tsx -t "followed games card|following from the dialog"`
Expected: FAIL with "Unable to find … followed-games".

- [ ] **Step 8: Wire it into Drops**

In `apps/frontend/src/routes/Drops.tsx`:

- Imports:
  - add `import { FollowedGamesCard } from "../components/FollowedGamesCard.js";`;
  - add `import { FollowGamesDialog } from "../components/FollowGamesDialog.js";`;
  - extend the followedGames import to `{ type FollowResponse, type FollowedGame, followSummary, viaGameName }`.
- State, after `followed`:

  ```ts
    const [followOpen, setFollowOpen] = useState(false);
    const [followNotice, setFollowNotice] = useState<string | null>(null);
  ```

- `loadSubs`: change its return type to `Promise<SubscriptionRow[]>`. Inside the `try`, compute `const list = Array.isArray(res.subscriptions) ? res.subscriptions : [];`, then `setSubs(list);` and `return list;`. In the `catch`, `return subs;`.
- After `mutate`, add:

  ```ts
    /**
     * Follows games, then says what it did.
     *
     * Not routed through `mutate`: that reports a failure on the page,
     * and the dialog wants the rejection so it can stay open with the
     * reason. The campaigns counted are the subscriptions that appeared,
     * which is what the follow's own resolve pass added.
     */
    async function follow(ids: string[], key: string): Promise<void> {
      setBusy({ key, label: "Following and checking for campaigns…" });
      try {
        const before = new Set(subs.map((s) => s.id));
        const res = await api.post<FollowResponse>("/api/followed-games", { ids });
        const after = await loadSubs();
        await loadRestart();
        setFollowNotice(followSummary(res, after.filter((s) => !before.has(s.id)).length));
      } finally {
        setBusy(null);
      }
    }
  ```

- In the JSX, directly before `{subs.length > 0 && (`, add:

  ```tsx
        <FollowedGamesCard
          games={followed}
          campaigns={data.campaigns}
          busy={busy !== null}
          notice={followNotice}
          onAdd={() => setFollowOpen(true)}
          onRemove={(id) => void mutate(
            "followed", "Unfollowing…",
            () => api.post(`/api/followed-games/${encodeURIComponent(id)}/remove`),
          )}
          onPoolSize={(id, poolSize) => void mutate(
            "followed", "Saving…",
            () => api.post(`/api/followed-games/${encodeURIComponent(id)}/pool-size`, { poolSize }),
          )}
        />
  ```

- Directly before the closing `</Stack>`, add:

  ```tsx
        <FollowGamesDialog
          opened={followOpen}
          onClose={() => setFollowOpen(false)}
          followed={followed}
          campaigns={data.campaigns}
          onConfirm={(games) => follow(games.map((g) => g.id), "followed")}
        />
  ```

- [ ] **Step 9: Run the frontend suite and build**

Run: `pnpm --filter @app/frontend test && pnpm --filter @app/frontend exec tsc -b`
Expected: all PASS, `tsc` exits 0.

- [ ] **Step 10: Checkpoint** — no commit.

---

### Task 9: Frontend — "Follow game" on campaign cards

**Files:**
- Modify: `apps/frontend/src/components/CampaignCard.tsx:259-283` (props), `:610-646` (action group)
- Modify: `apps/frontend/src/routes/Drops.tsx` (campaign grid)
- Test: `apps/frontend/src/components/CampaignCard.test.tsx`, `apps/frontend/src/routes/Drops.test.tsx`

**Interfaces:**
- Consumes: `follow(ids, key)` in Drops (Task 8).
- Produces: `CampaignCard` props `gameFollowed?: boolean; onFollowGame?: () => void`.

- [ ] **Step 1: Write the failing tests**

In `CampaignCard.test.tsx`, which already has a `campaign(over)` fixture factory at line 10:

```tsx
test("offers to follow the campaign's game", async () => {
  const onFollowGame = vi.fn();
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={() => {}} onFollowGame={onFollowGame} />);
  await userEvent.click(screen.getByRole("button", { name: "Follow game" }));
  expect(onFollowGame).toHaveBeenCalled();
});

test("a followed game reads as followed and cannot be followed again", () => {
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={() => {}} onFollowGame={() => {}} gameFollowed />);
  const button = screen.getByRole("button", { name: "Following game" });
  expect(button).toHaveAttribute("aria-disabled", "true");
});

test("a campaign with no game offers no follow", () => {
  renderApp(<CampaignCard campaign={campaign({ game: null })} onSubscribe={() => {}} onFollowGame={() => {}} />);
  expect(screen.queryByRole("button", { name: /follow/i })).toBeNull();
});
```

In `Drops.test.tsx`:

```ts
test("Follow game on a card follows that campaign's game", async () => {
  followAnswer = { added: [{ id: "g2", name: "Beta Game", slug: "beta-game", boxArtUrl: null }],
                   alreadyFollowed: [], notFound: [] };
  withSubs([]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Beta Campaign")).toBeTruthy());
  const card = screen.getAllByTestId("campaign-card")
    .find((c) => c.textContent?.includes("Beta Campaign"))!;
  await userEvent.click(within(card).getByRole("button", { name: "Follow game" }));
  await waitFor(() => {
    const post = calls.find((c) => c.url === "/api/followed-games");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ ids: ["g2"] });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/frontend exec vitest run src/components/CampaignCard.test.tsx src/routes/Drops.test.tsx -t "follow"`
Expected: FAIL because there is no "Follow game" button.

- [ ] **Step 3: Implement**

`CampaignCard.tsx`:

- Add to the destructured props: `gameFollowed = false, onFollowGame,`.
- Add to the props type:

  ```ts
    /** Whether the campaign's game is already followed. */
    gameFollowed?: boolean;
    /** Follows the campaign's game; absent hides the button. */
    onFollowGame?: () => void;
  ```

- In the action `Group`:
  - remove `ml="auto"` from both Subscribe `Button`s;
  - wrap the whole `{onSubscribe !== undefined && (…)}` expression in `<Group gap={6} wrap="nowrap" ml="auto">…</Group>`;
  - inside that group, before the Subscribe expression, add:

    ```tsx
            {onFollowGame !== undefined && campaign.game !== null && (
              <Tooltip
                label={gameFollowed
                  ? `You follow ${campaign.game.displayName}: its campaigns are subscribed as they appear`
                  : `Subscribe to every ${campaign.game.displayName} campaign, now and as they appear`}
                multiline
                w={240}
              >
                <Button
                  size="compact-xs"
                  variant="default"
                  loading={!gameFollowed && busy !== undefined}
                  // data-disabled rather than disabled when followed, like
                  // Subscribe's: a disabled button fires no mouse events,
                  // so the tooltip saying why would never open.
                  data-disabled={gameFollowed || undefined}
                  aria-disabled={gameFollowed || undefined}
                  onClick={(event) => {
                    if (gameFollowed) event.preventDefault();
                    else onFollowGame();
                  }}
                >
                  {gameFollowed ? "Following game" : "Follow game"}
                </Button>
              </Tooltip>
            )}
    ```

`Drops.tsx`, in the campaign grid's `<CampaignCard`, add:

```tsx
                gameFollowed={campaign.game !== null
                  && followed.some((g) => g.id === campaign.game?.id)}
                onFollowGame={campaign.game === null ? undefined : () => {
                  void follow([campaign.game!.id], campaign.id).catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : "could not follow that game");
                  });
                }}
```

- [ ] **Step 4: Run the frontend suite and build**

Run: `pnpm --filter @app/frontend test && pnpm --filter @app/frontend exec tsc -b`
Expected: all PASS, `tsc` exits 0.

- [ ] **Step 5: Checkpoint** — no commit.

---

### Task 10: README, real-app verification, review and commit

**Files:**
- Modify: `README.md` (after the Drops section's last paragraph, around line 182)

- [ ] **Step 1: Document it**

Append to the `### Drops` section of `README.md`:

```markdown
**Following games.** *Follow games* on the Drops page searches Twitch's
category list (by name, or paste a Twitch game ID) and follows the games
you tick. Whenever a followed game has a drop campaign, the app
subscribes to it for you, marked **Auto**, and it takes its place in the
campaign queue like any other. Removing an Auto subscription skips that
campaign; the game's future campaigns are still added. Unfollowing a game
keeps the subscriptions it already made. The search asks Twitch directly
and needs no login.
```

- [ ] **Step 2: Full test suites and builds**

Run: `pnpm test && pnpm build && uv run pytest python/tests -q`
Expected: every suite PASS, and both builds exit 0.

- [ ] **Step 3: Run the built backend under plain Node**

Vitest hides Node ESM bugs, so exercise `dist/` for real:

```bash
node --input-type=module -e "
import { twitchGames } from './apps/backend/dist/twitch/categories.js';
const g = twitchGames();
console.log(await g.find('elden ring'));
console.log(await g.byId('512953'));
console.log(await g.find('512953'));
"
```

Expected:
- the first result of `find('elden ring')` is `{ id: '512953', name: 'ELDEN RING', slug: 'elden-ring', boxArtUrl: 'https://static-cdn.jtvnw.net/ttv-boxart/512953_IGDB-144x192.jpg' }`;
- `byId` returns the same game;
- `find('512953')` lists it first.

- [ ] **Step 4: Drive the app with Playwright**

Start the preview (`pnpm preview`, with the `.env` the container already uses). Then, with the Playwright set up at `~/.pw-tools`:
1. `POST /api/session` to authenticate. Nav rows are buttons and routing is client-side, so open Drops by clicking its nav button.
2. Pick a game that has a live campaign in the catalogue right now (read `GET /api/campaigns` and take the first `game` of a campaign that has opened).
3. Click **Follow games**, search that game, tick it, confirm.
4. Assert:
   - the Followed games card lists the game;
   - the notice reports at least one campaign subscribed;
   - the new subscription row shows the **Auto** badge;
   - after `GET /api/subscriptions`, the row has `channels.length > 0` (or `queue.state` is `waiting`/`scheduled` when the queue is on).
5. Remove that subscription, `POST /api/subscriptions/resolve`, and assert it has not come back.
6. Unfollow the game to restore the config.
7. Screenshot the card with the game followed, the dialog showing search results, and the Auto badge. Send all three to the user with SendUserFile, not Read.

- [ ] **Step 5: Hand the change to the user for review**

Show `git status` and `git diff --stat`, summarise what changed per task, and link the screenshots. **Wait for the user's approval.**

- [ ] **Step 6: Commit to main (after approval only)**

```bash
git add README.md apps/backend apps/frontend docs/superpowers/plans/2026-09-26-followed-games.md
git commit -m "$(cat <<'EOF'
feat(drops): follow games and subscribe to their campaigns automatically

Replaces the unused game subscription kind with followed games: a Twitch
category search (plain GQL, no session) picks the games, and each drops
pass subscribes to their campaigns as ordinary queued campaign
subscriptions marked Auto. Removing one skips that campaign for good;
campaign.new now announces automatic subscriptions.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```
