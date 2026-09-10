# Full Streamer & Miner Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every upstream `StreamerSettings` field editable per streamer and as a global default in the web UI, plus the miner-wide options currently hardcoded in `run.py`.

**Architecture:** Widen the existing three-layer config contract (Zod schema → snake_case mapper → `miner_config.py`) to carry nested `bet`/`simulate_hls_playback` objects and a new top-level `miner` object, then build the editing surfaces that never existed: a tabbed Modal per streamer with inherit-vs-override semantics, and sections on the Settings page for global defaults and miner-wide options. No new API endpoints — both screens use the existing staged-edit flow (`draft` → `PUT /api/config` → `POST /api/config/apply`).

**Tech Stack:** TypeScript, Zod, Fastify (backend); React 19, Mantine 9.6, vitest 5 + jsdom 30 + Testing Library (frontend); Python 3.12, pytest (miner adapter).

**Spec:** `docs/superpowers/specs/2026-09-10-streamer-settings-design.md`

## Global Constraints

- **Three-way parity is enforced by a test.** `BOOL_SETTINGS` and `TO_PYTHON` (`apps/backend/src/config/schema.ts`) and `ALLOWED_SETTINGS` (`python/miner_config.py`) must stay in sync; `python/tests/test_schema_parity.py` asserts it by scraping the TS source. Any key added to one must be added to all three in the same task.
- **Absent keys, never sentinels.** An unset per-streamer setting means the key is absent from `settings`. An override of `false` must stay distinguishable from "not set". Never write a sentinel value to mean "inherit".
- **Mantine `Select`/`Combobox`/`Tooltip` are cleared for use** (retested 2026-09-10: vitest 5 / jsdom 30, full suite 35 files / 309 tests / 22s, no hangs). Two gotchas, both verified:
  - The dropdown is portalled into a wrapper that keeps `display: none` while `aria-expanded="true"`. Testing Library filters those options out, so query them with `{ hidden: true }`: `screen.getByRole("option", { name: "Smart", hidden: true })`.
  - The Select target is `role="combobox"`, **not** `role="textbox"`. Mantine's own testing docs show `getByRole('textbox')` — that snippet is for an older major and does not match.
- **CI gates every commit:** `pnpm run build` (runs `tsc -b`), `pnpm test`, `uv run pytest`. A commit that breaks type-checking fails CI even if tests pass.
- **Enum values are copied verbatim from upstream** (extracted from `vendor/miner/TwitchChannelPointsMiner/classes/entities/Bet.py` and `classes/Settings.py`):
  - `Strategy`: `MOST_VOTED HIGH_ODDS PERCENTAGE SMART_MONEY SMART NUMBER_1 NUMBER_2 NUMBER_3 NUMBER_4 NUMBER_5 NUMBER_6 NUMBER_7 NUMBER_8`
  - `Condition`: `GT LT GTE LTE`
  - `DelayMode`: `FROM_START FROM_END PERCENTAGE`
  - `OutcomeKeys` (the six real ones only — upstream comments `DECISION_USERS`/`DECISION_POINTS` as "This key does not exist"): `percentage_users odds_percentage odds top_points total_users total_points`
  - `Priority`: `ORDER STREAK DROPS SUBSCRIBED POINTS_ASCENDING POINTS_DESCENDING WATCH_SESSION WEEKLY_REWARDS`
- **`BetSettings` defaults** (from `BetSettings.default()`): strategy `SMART`, percentage `5`, percentage_gap `20`, max_points `50000`, minimum_points `0`, stealth_mode `false`, delay `6`, delay_mode `FROM_END`. `StreamerSettings.default()`: the seven booleans default `true` except `community_goals` (`false`); `chat` `ONLINE`; `points_limit` `false`; `simulate_hls_playback` `HLSSettings(refresh_before=120)`.
- **Notification integrations are out of scope** and must not be added to the schema, the config, or the UI.

---

## File Structure

**Backend (`apps/backend/src/config/`)**
- `schema.ts` — modify. Nested settings schemas, nested `TO_PYTHON`, recursive mappers, new `minerSchema`.
- `store.test.ts` — modify. Round-trip and validation coverage for nested keys and `miner`.
- `store.ts` — modify. Only to pass `miner` through `loadConfig`/`saveConfig`.

**Python (`python/`)**
- `miner_config.py` — modify. `ALLOWED_SETTINGS` grows; `_settings` builds `BetSettings`/`FilterCondition`/`HLSSettings`; `build_mine_kwargs` returns miner-wide options.
- `run.py` — modify. Pass `priority`, `claim_drops_startup`, `gql`, `weekly_rewards` from config.
- `tests/test_miner_config.py`, `tests/test_schema_parity.py`, `tests/test_contract.py` — modify.

**Frontend (`apps/frontend/src/`)**
- `lib/settingsFields.ts` — create. One declarative table describing every per-streamer field (key, kind, label, help, upstream default). Both the dialog and the defaults section render from it, so a new field is added in one place.
- `lib/settingsFields.test.ts` — create.
- `components/SettingsFieldRow.tsx` — create. One field, in either "inherit-capable" mode (per-streamer) or "plain" mode (global defaults).
- `components/SettingsFieldRow.test.tsx` — create.
- `components/StreamerSettingsModal.tsx` — create. The tabbed dialog.
- `components/StreamerSettingsModal.test.tsx` — create.
- `components/StreamerRow.tsx` — modify. Gear button; correct the stale Tooltip comment.
- `routes/Streamers.tsx` — modify. Own the modal's open state, write `settings` into `draft`; correct the stale Tooltip comment.
- `routes/Settings.tsx` — modify. Global defaults section + miner-wide section.
- `routes/Dashboard.tsx` — modify. Correct the stale comment only (the `NativeSelect` stays).

**Docs**
- `README.md` — modify. Manual notification setup.

---

## Task 1: Nested settings in the Zod schema and mappers

**Files:**
- Modify: `apps/backend/src/config/schema.ts:1-27` (the `BOOL_SETTINGS`/`TO_PYTHON`/`settingsSchema` block) and `:73-85` (the two mappers)
- Test: `apps/backend/src/config/store.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `settingsSchema` accepting `bet` and `simulateHlsPlayback`; `TO_PYTHON` (flat, camel→snake for scalar keys); `NESTED_TO_PYTHON: Record<string, Record<string, string>>`; `settingsToPython(settings)` / `settingsFromPython(raw)` both recursive. Task 2 mirrors these key names in Python; Task 6 renders from them.

- [ ] **Step 1: Write the failing tests**

Add to `apps/backend/src/config/store.test.ts`, inside the existing `describe("schema", ...)` block:

```ts
  test("accepts a full bet block", () => {
    const mk = (bet: unknown) => ({
      ...valid,
      streamers: [{ username: "alpha", enabled: true, settings: { bet } }],
    });
    expect(configSchema.safeParse(mk({
      strategy: "SMART", percentage: 5, percentageGap: 20, maxPoints: 50000,
      minimumPoints: 0, stealthMode: false, delay: 6, delayMode: "FROM_END",
      filterCondition: { by: "total_users", where: "LTE", value: 800 },
    })).success).toBe(true);
    expect(configSchema.safeParse(mk({ strategy: "NOPE" })).success).toBe(false);
    expect(configSchema.safeParse(mk({ percentage: -1 })).success).toBe(false);
    expect(configSchema.safeParse(mk({ evil: 1 })).success).toBe(false);
    expect(configSchema.safeParse(mk({
      filterCondition: { by: "decision_users", where: "LTE", value: 1 },
    })).success).toBe(false);
  });

  test("accepts simulateHlsPlayback as false or a refresh window", () => {
    const mk = (v: unknown) => ({
      ...valid,
      streamers: [{ username: "alpha", enabled: true, settings: { simulateHlsPlayback: v } }],
    });
    expect(configSchema.safeParse(mk(false)).success).toBe(true);
    expect(configSchema.safeParse(mk({ refreshBefore: 120 })).success).toBe(true);
    expect(configSchema.safeParse(mk({ refreshBefore: 0 })).success).toBe(false);
    expect(configSchema.safeParse(mk(true)).success).toBe(false);
  });
```

Add a new `describe` block at the end of the file:

```ts
describe("nested snake_case mapping", () => {
  const camel = {
    makePredictions: true,
    simulateHlsPlayback: { refreshBefore: 120 },
    bet: {
      strategy: "SMART", percentageGap: 20, maxPoints: 50000,
      minimumPoints: 0, stealthMode: false, delayMode: "FROM_END",
      filterCondition: { by: "total_users", where: "LTE", value: 800 },
    },
  };
  const snake = {
    make_predictions: true,
    simulate_hls_playback: { refresh_before: 120 },
    bet: {
      strategy: "SMART", percentage_gap: 20, max_points: 50000,
      minimum_points: 0, stealth_mode: false, delay_mode: "FROM_END",
      filter_condition: { by: "total_users", where: "LTE", value: 800 },
    },
  };

  test("renames keys inside bet and filter_condition", () => {
    expect(settingsToPython(camel)).toEqual(snake);
  });

  test("round-trips back to camelCase", () => {
    expect(settingsFromPython(snake)).toEqual(camel);
  });

  test("leaves a false simulateHlsPlayback as a bare false", () => {
    expect(settingsToPython({ simulateHlsPlayback: false }))
      .toEqual({ simulate_hls_playback: false });
    expect(settingsFromPython({ simulate_hls_playback: false }))
      .toEqual({ simulateHlsPlayback: false });
  });
});
```

Add `settingsFromPython, settingsToPython` to the existing import from `./schema.js` at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/backend && npx vitest run src/config/store.test.ts`
Expected: FAIL — the bet block is rejected by `.strict()`, and the mapper tests fail because nested keys come back unrenamed.

- [ ] **Step 3: Implement the schema and mappers**

In `apps/backend/src/config/schema.ts`, replace the block from `export const TO_PYTHON` through the end of `settingsSchema` with:

```ts
export const TO_PYTHON: Record<string, string> = {
  makePredictions: "make_predictions",
  followRaid: "follow_raid",
  claimDrops: "claim_drops",
  claimMoments: "claim_moments",
  watchStreak: "watch_streak",
  communityGoals: "community_goals",
  weeklyRewards: "weekly_rewards",
  pointsLimit: "points_limit",
  chat: "chat",
  bet: "bet",
  simulateHlsPlayback: "simulate_hls_playback",
};

/**
 * Key renames *inside* the nested settings objects, keyed by the camelCase
 * name of the object itself. A flat one-level rename would leave these
 * untouched and hand Python a dict whose inner keys StreamerSettings
 * rejects -- which is why the mappers below recurse.
 */
export const NESTED_TO_PYTHON: Record<string, Record<string, string>> = {
  bet: {
    strategy: "strategy",
    percentage: "percentage",
    percentageGap: "percentage_gap",
    maxPoints: "max_points",
    minimumPoints: "minimum_points",
    stealthMode: "stealth_mode",
    delay: "delay",
    delayMode: "delay_mode",
    filterCondition: "filter_condition",
  },
  filterCondition: { by: "by", where: "where", value: "value" },
  simulateHlsPlayback: { refreshBefore: "refresh_before" },
};

/** Upstream marks DECISION_USERS/DECISION_POINTS as keys that do not exist. */
export const OUTCOME_KEYS = [
  "percentage_users", "odds_percentage", "odds",
  "top_points", "total_users", "total_points",
] as const;

export const STRATEGIES = [
  "MOST_VOTED", "HIGH_ODDS", "PERCENTAGE", "SMART_MONEY", "SMART",
  "NUMBER_1", "NUMBER_2", "NUMBER_3", "NUMBER_4",
  "NUMBER_5", "NUMBER_6", "NUMBER_7", "NUMBER_8",
] as const;

const filterConditionSchema = z
  .object({
    by: z.enum(OUTCOME_KEYS),
    where: z.enum(["GT", "LT", "GTE", "LTE"]),
    value: z.number(),
  })
  .strict();

const betSchema = z
  .object({
    strategy: z.enum(STRATEGIES).optional(),
    percentage: z.number().int().min(0).max(100).optional(),
    percentageGap: z.number().int().min(0).max(100).optional(),
    maxPoints: z.number().int().nonnegative().optional(),
    minimumPoints: z.number().int().nonnegative().optional(),
    stealthMode: z.boolean().optional(),
    delay: z.number().nonnegative().optional(),
    delayMode: z.enum(["FROM_START", "FROM_END", "PERCENTAGE"]).optional(),
    filterCondition: filterConditionSchema.optional(),
  })
  .strict();

const hlsSchema = z
  .union([
    z.literal(false),
    z.object({ refreshBefore: z.number().int().positive() }).strict(),
  ]);

const settingsSchema = z
  .object({
    ...Object.fromEntries(BOOL_SETTINGS.map((k) => [k, z.boolean().optional()])),
    pointsLimit: z.union([z.literal(false), z.number().int().positive()]).optional(),
    chat: z.enum(["ALWAYS", "NEVER", "ONLINE", "OFFLINE"]).optional(),
    bet: betSchema.optional(),
    simulateHlsPlayback: hlsSchema.optional(),
  })
  .strict();
```

Replace the two mapper functions at the bottom of the file with:

```ts
/**
 * Renames one level of keys, recursing into the nested settings objects
 * named in NESTED_TO_PYTHON. `false` is a legal value for
 * simulateHlsPlayback and must survive as a bare false rather than being
 * treated as an object to walk.
 */
function renameKeys(
  input: Record<string, unknown>,
  map: Record<string, string>,
  nested: Record<string, Record<string, string>>,
  nestedKeyOf: (camelOrSnake: string) => string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      const renamed = map[key] ?? key;
      const childMap = nested[nestedKeyOf(key)];
      if (childMap && value !== null && typeof value === "object") {
        return [renamed, renameKeys(
          value as Record<string, unknown>, childMap, nested, nestedKeyOf,
        )];
      }
      return [renamed, value];
    }),
  );
}

const invert = (map: Record<string, string>) =>
  Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));

export function settingsToPython(settings: Record<string, unknown>) {
  return renameKeys(settings, TO_PYTHON, NESTED_TO_PYTHON, (k) => k);
}

export function settingsFromPython(raw: Record<string, unknown>) {
  const back = invert(TO_PYTHON);
  const nestedBack = Object.fromEntries(
    Object.entries(NESTED_TO_PYTHON).map(([k, v]) => [k, invert(v)]),
  );
  return renameKeys(raw, back, nestedBack, (k) => back[k] ?? k);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/backend && npx vitest run src/config/store.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Type-check**

Run: `pnpm run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/config/schema.ts apps/backend/src/config/store.test.ts
git commit -m "feat(config): carry nested bet and HLS settings through the schema"
```

---

## Task 2: Build the nested settings objects in the miner adapter

**Files:**
- Modify: `python/miner_config.py:1-33` (imports, `ALLOWED_SETTINGS`, `_settings`)
- Test: `python/tests/test_miner_config.py`

**Interfaces:**
- Consumes: the snake_case shape Task 1 writes — `bet.{strategy,percentage,percentage_gap,max_points,minimum_points,stealth_mode,delay,delay_mode,filter_condition{by,where,value}}`, `simulate_hls_playback` as `false` or `{refresh_before: int}`.
- Produces: `_settings` returning a `StreamerSettings` whose `bet` is a `BetSettings` and whose `simulate_hls_playback` is `HLSSettings | False`. `ALLOWED_SETTINGS` grown by `bet` and `simulate_hls_playback` (Task 4's parity test asserts this against Task 1's `TO_PYTHON`).

- [ ] **Step 1: Write the failing tests**

Add to `python/tests/test_miner_config.py`:

```python
def test_bet_dict_becomes_bet_settings_with_enums():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"bet": {
            "strategy": "HIGH_ODDS",
            "percentage_gap": 30,
            "delay_mode": "FROM_START",
            "filter_condition": {"by": "total_users", "where": "LTE", "value": 800},
        }}},
    ])
    bet = build_streamers(c)[0].settings.bet
    assert bet.strategy is Strategy.HIGH_ODDS
    assert bet.percentage_gap == 30
    assert bet.delay_mode is DelayMode.FROM_START
    assert bet.filter_condition.by == "total_users"
    assert bet.filter_condition.where is Condition.LTE
    assert bet.filter_condition.value == 800


def test_bet_without_a_filter_condition_leaves_it_unset():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"bet": {"percentage": 7}}},
    ])
    bet = build_streamers(c)[0].settings.bet
    assert bet.percentage == 7
    assert bet.filter_condition is None


def test_simulate_hls_playback_false_is_preserved_not_coerced():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True,
         "settings": {"simulate_hls_playback": False}},
    ])
    assert build_streamers(c)[0].settings.simulate_hls_playback is False


def test_simulate_hls_playback_dict_becomes_hls_settings():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True,
         "settings": {"simulate_hls_playback": {"refresh_before": 90}}},
    ])
    hls = build_streamers(c)[0].settings.simulate_hls_playback
    assert isinstance(hls, HLSSettings)
    assert hls.refresh_before == 90


def test_unknown_bet_key_is_rejected():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"bet": {"evil": 1}}},
    ])
    with pytest.raises(ValueError, match="evil"):
        build_streamers(c)


def test_per_streamer_bet_replaces_the_default_bet_wholesale():
    """A dict merge is shallow, so this documents the chosen semantics:
    a streamer that sets `bet` owns the whole block, rather than having
    its keys merged one by one into the default bet."""
    c = cfg(defaults={"bet": {"percentage": 5, "max_points": 100}},
            streamers=[{"username": "alpha", "enabled": True,
                        "settings": {"bet": {"percentage": 9}}}])
    bet = build_streamers(c)[0].settings.bet
    assert bet.percentage == 9
    assert bet.max_points is None
```

Extend the imports at the top of the file:

```python
from TwitchChannelPointsMiner.classes.entities.Bet import Condition, DelayMode, Strategy
from TwitchChannelPointsMiner.classes.entities.Streamer import HLSSettings
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest python/tests/test_miner_config.py -v`
Expected: FAIL with `ValueError: unknown streamer settings: ['bet']`.

- [ ] **Step 3: Implement**

In `python/miner_config.py`, extend the imports:

```python
from TwitchChannelPointsMiner.classes.entities.Bet import (
    BetSettings,
    Condition,
    DelayMode,
    FilterCondition,
    Strategy,
)
from TwitchChannelPointsMiner.classes.entities.Streamer import (
    HLSSettings,
    Streamer,
    StreamerSettings,
)
```

Replace `ALLOWED_SETTINGS` and `_settings` with:

```python
ALLOWED_SETTINGS = frozenset(
    BOOL_SETTINGS + ("points_limit", "chat", "bet", "simulate_hls_playback")
)

BET_ENUMS = {"strategy": Strategy, "delay_mode": DelayMode}
ALLOWED_BET = frozenset(
    ("strategy", "percentage", "percentage_gap", "max_points", "minimum_points",
     "stealth_mode", "delay", "delay_mode", "filter_condition")
)
ALLOWED_FILTER = frozenset(("by", "where", "value"))


def _reject_unknown(merged, allowed, what):
    unknown = set(merged) - allowed
    if unknown:
        raise ValueError(f"unknown {what}: {sorted(unknown)}")


def _filter_condition(raw: dict) -> FilterCondition:
    _reject_unknown(raw, ALLOWED_FILTER, "bet filter_condition keys")
    return FilterCondition(
        by=raw.get("by"),
        where=Condition[raw["where"]] if raw.get("where") else None,
        value=raw.get("value"),
    )


def _bet(raw: dict) -> BetSettings:
    _reject_unknown(raw, ALLOWED_BET, "bet settings")
    kwargs = {k: v for k, v in raw.items() if k != "filter_condition"}
    for name, enum in BET_ENUMS.items():
        if kwargs.get(name) is not None:
            kwargs[name] = enum[kwargs[name]]
    if raw.get("filter_condition") is not None:
        kwargs["filter_condition"] = _filter_condition(raw["filter_condition"])
    return BetSettings(**kwargs)


def _settings(defaults: dict, overrides: dict) -> StreamerSettings:
    merged = {**defaults, **overrides}
    _reject_unknown(merged, ALLOWED_SETTINGS, "streamer settings")
    if merged.get("chat") is not None:
        merged["chat"] = ChatPresence[merged["chat"]]
    if merged.get("bet") is not None:
        merged["bet"] = _bet(merged["bet"])
    # `False` disables HLS playback and must reach StreamerSettings as a
    # bare False; only a dict describes a refresh window.
    hls = merged.get("simulate_hls_playback")
    if isinstance(hls, dict):
        _reject_unknown(hls, frozenset(("refresh_before",)), "simulate_hls_playback keys")
        merged["simulate_hls_playback"] = HLSSettings(**hls)
    return StreamerSettings(**merged)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest python/tests/test_miner_config.py -v`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add python/miner_config.py python/tests/test_miner_config.py
git commit -m "feat(miner): build BetSettings and HLSSettings from config.json"
```

---

## Task 3: Miner-wide options in config and `run.py`

**Files:**
- Modify: `apps/backend/src/config/schema.ts` (add `minerSchema` to `configSchema`), `apps/backend/src/config/store.ts:6-13` (`DEFAULT_CONFIG`)
- Modify: `python/miner_config.py` (`build_mine_kwargs`), `python/run.py:85-89` (the `mine()` call and constructor)
- Test: `apps/backend/src/config/store.test.ts`, `python/tests/test_miner_config.py`, `python/tests/test_contract.py`

**Interfaces:**
- Consumes: `configSchema` from Task 1.
- Produces: a top-level `miner` object — `{priority: Priority[], claimDropsStartup: boolean, gql: {attempts, attemptIntervalSeconds}, weeklyRewards: false | BasicConfiguration}` — mapped to snake_case on disk. `build_mine_kwargs(cfg)` returns `{"followers", "followers_order", "priority", "claim_drops_startup", "gql", "weekly_rewards"}`. Task 7 renders these.

- [ ] **Step 1: Write the failing tests**

Add to `apps/backend/src/config/store.test.ts` inside `describe("schema", ...)`:

```ts
  test("accepts miner-wide options and rejects unknown priorities", () => {
    const mk = (miner: unknown) => ({ ...valid, miner });
    expect(configSchema.safeParse(mk({
      priority: ["STREAK", "DROPS", "ORDER"],
      claimDropsStartup: true,
      gql: { attempts: 3, attemptIntervalSeconds: 1 },
      weeklyRewards: { maxConcurrent: 2, maxClipWatchSeconds: 30,
                       maxVodWatchSeconds: 480, intervalSeconds: 20,
                       maxFailuresPerStreamer: 1, failureCooldownSeconds: 3600 },
    })).success).toBe(true);
    expect(configSchema.safeParse(mk({ weeklyRewards: false })).success).toBe(true);
    expect(configSchema.safeParse(mk({ priority: ["NOPE"] })).success).toBe(false);
    expect(configSchema.safeParse(mk({ evil: 1 })).success).toBe(false);
  });
```

Add to `python/tests/test_miner_config.py`:

```python
def test_mine_kwargs_default_the_miner_wide_options():
    kwargs = build_mine_kwargs(cfg())
    assert kwargs["followers"] is True
    assert kwargs["priority"] is None
    assert kwargs["claim_drops_startup"] is False
    assert kwargs["gql"] is None
    assert kwargs["weekly_rewards"] is None


def test_mine_kwargs_carry_priority_and_startup_claim():
    kwargs = build_mine_kwargs(cfg(miner={
        "priority": ["STREAK", "ORDER"],
        "claim_drops_startup": True,
        "gql": {"attempts": 5, "attempt_interval_seconds": 2},
    }))
    assert kwargs["priority"] == [Priority.STREAK, Priority.ORDER]
    assert kwargs["claim_drops_startup"] is True
    assert kwargs["gql"].attempts == 5
    assert kwargs["gql"].attempt_interval_seconds == 2


def test_weekly_rewards_false_disables_rather_than_configuring():
    assert build_mine_kwargs(cfg(miner={"weekly_rewards": False}))["weekly_rewards"] is False


def test_weekly_rewards_dict_becomes_basic_configuration():
    kwargs = build_mine_kwargs(cfg(miner={"weekly_rewards": {"max_concurrent": 4}}))
    assert kwargs["weekly_rewards"].max_concurrent == 4
```

Import `Priority` in that test file: `from TwitchChannelPointsMiner.classes.Settings import Priority`.

Add to `python/tests/test_contract.py` — this pins the field names upstream's `example.py` gets wrong:

```python
def test_weekly_rewards_basic_configuration_field_names():
    """example.py documents max_concurrent_watch/max_seconds_clips/
    max_seconds_vods/loop_interval_seconds, none of which exist on the
    dataclass -- passing them raises TypeError. Pin the real names so an
    upstream rename fails here by name instead of at miner startup."""
    from TwitchChannelPointsMiner.classes.ClipVodWatcher import BasicConfiguration
    assert set(BasicConfiguration.__dataclass_fields__) == {
        "max_concurrent", "max_clip_watch_seconds", "max_vod_watch_seconds",
        "interval_seconds", "max_failures_per_streamer", "failure_cooldown_seconds",
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest python/tests/test_miner_config.py python/tests/test_contract.py -v && (cd apps/backend && npx vitest run src/config/store.test.ts)`
Expected: FAIL — `KeyError: 'priority'` in Python; `miner` rejected by `.strict()` in TS.

- [ ] **Step 3: Implement the schema side**

In `apps/backend/src/config/schema.ts`, add before `configSchema`:

```ts
export const PRIORITIES = [
  "ORDER", "STREAK", "DROPS", "SUBSCRIBED",
  "POINTS_ASCENDING", "POINTS_DESCENDING", "WATCH_SESSION", "WEEKLY_REWARDS",
] as const;

/** Field names are upstream's dataclass, not example.py's (which are wrong). */
const weeklyRewardsSchema = z.union([
  z.literal(false),
  z.object({
    maxConcurrent: z.number().int().positive().optional(),
    maxClipWatchSeconds: z.number().positive().optional(),
    maxVodWatchSeconds: z.number().positive().optional(),
    intervalSeconds: z.number().positive().optional(),
    maxFailuresPerStreamer: z.number().int().nonnegative().optional(),
    failureCooldownSeconds: z.number().nonnegative().optional(),
  }).strict(),
]);

const minerSchema = z
  .object({
    priority: z.array(z.enum(PRIORITIES)).optional(),
    claimDropsStartup: z.boolean().optional(),
    gql: z.object({
      attempts: z.number().int().positive(),
      attemptIntervalSeconds: z.number().nonnegative(),
    }).strict().optional(),
    weeklyRewards: weeklyRewardsSchema.optional(),
  })
  .strict();

export const MINER_TO_PYTHON: Record<string, string> = {
  priority: "priority",
  claimDropsStartup: "claim_drops_startup",
  gql: "gql",
  weeklyRewards: "weekly_rewards",
};

const MINER_NESTED_TO_PYTHON: Record<string, Record<string, string>> = {
  gql: { attempts: "attempts", attemptIntervalSeconds: "attempt_interval_seconds" },
  weeklyRewards: {
    maxConcurrent: "max_concurrent",
    maxClipWatchSeconds: "max_clip_watch_seconds",
    maxVodWatchSeconds: "max_vod_watch_seconds",
    intervalSeconds: "interval_seconds",
    maxFailuresPerStreamer: "max_failures_per_streamer",
    failureCooldownSeconds: "failure_cooldown_seconds",
  },
};

export function minerToPython(miner: Record<string, unknown>) {
  return renameKeys(miner, MINER_TO_PYTHON, MINER_NESTED_TO_PYTHON, (k) => k);
}

export function minerFromPython(raw: Record<string, unknown>) {
  const back = invert(MINER_TO_PYTHON);
  const nestedBack = Object.fromEntries(
    Object.entries(MINER_NESTED_TO_PYTHON).map(([k, v]) => [k, invert(v)]),
  );
  return renameKeys(raw, back, nestedBack, (k) => back[k] ?? k);
}
```

Move `renameKeys` and `invert` above this block so both mapper pairs can use them. Add `miner: minerSchema` to `configSchema`'s object.

In `apps/backend/src/config/store.ts`, add `miner: {},` to `DEFAULT_CONFIG`, and map it in both directions alongside `defaults` — in `loadConfig`'s `camel` object add `miner: minerFromPython((r.miner as Record<string, unknown>) ?? {})`, and in `saveConfig`'s `onDisk` add `miner: minerToPython(valid.miner)`. Import both from `./schema.js`.

- [ ] **Step 4: Implement the Python side**

In `python/miner_config.py`, add imports and replace `build_mine_kwargs`:

```python
from TwitchChannelPointsMiner.classes.ClipVodWatcher import BasicConfiguration
from TwitchChannelPointsMiner.classes.Settings import Priority
from TwitchChannelPointsMiner.utils.AttemptStrategy import AttemptStrategy


def build_mine_kwargs(cfg: dict) -> dict:
    """Miner-wide options. `None` means "let upstream pick its default",
    which is not the same as False -- weekly_rewards=False disables the
    feature, weekly_rewards=None takes upstream's BasicConfiguration."""
    miner = cfg.get("miner") or {}

    priority = miner.get("priority")
    gql = miner.get("gql")
    weekly = miner.get("weekly_rewards")

    return {
        "followers": bool(cfg.get("followers", False)),
        "followers_order": cfg.get("followersOrder", "ASC"),
        "priority": [Priority[p] for p in priority] if priority else None,
        "claim_drops_startup": bool(miner.get("claim_drops_startup", False)),
        "gql": AttemptStrategy(**gql) if gql else None,
        "weekly_rewards": (
            BasicConfiguration(**weekly) if isinstance(weekly, dict) else weekly
        ),
    }
```

In `python/run.py`, pass the new options. Add `claim_drops_startup=kwargs["claim_drops_startup"],` and `priority=kwargs["priority"],` and `gql=kwargs["gql"],` and `weekly_rewards=kwargs["weekly_rewards"],` to the `TwitchChannelPointsMiner(...)` call — but note `kwargs` is currently computed *after* the constructor, so move `kwargs = build_mine_kwargs(cfg)` to just above it. Upstream treats `None` as "use my default" for all four, so passing `None` is safe and matches today's behaviour.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest python/tests/ -v && (cd apps/backend && npx vitest run) && pnpm run build`
Expected: PASS everywhere, exit 0 from the build.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/config/schema.ts apps/backend/src/config/store.ts apps/backend/src/config/store.test.ts python/miner_config.py python/run.py python/tests/test_miner_config.py python/tests/test_contract.py
git commit -m "feat(config): make the miner-wide options configurable"
```

---

## Task 4: Extend the schema-parity test to the nested maps

**Files:**
- Modify: `python/tests/test_schema_parity.py`

**Interfaces:**
- Consumes: `TO_PYTHON` and `NESTED_TO_PYTHON` from Task 1, `ALLOWED_SETTINGS`/`ALLOWED_BET`/`ALLOWED_FILTER` from Task 2.
- Produces: nothing consumed downstream — this is the guard that keeps the three layers honest.

- [ ] **Step 1: Write the failing test**

Replace the body of `python/tests/test_schema_parity.py` with:

```python
"""The Zod schema and miner_config must expose the same settings keys."""
import pathlib
import re

from miner_config import ALLOWED_BET, ALLOWED_FILTER, ALLOWED_SETTINGS

SOURCE = pathlib.Path("apps/backend/src/config/schema.ts")


def _block(source: str, pattern: str) -> str:
    match = re.search(pattern, source, re.S)
    assert match, f"{pattern} not found in schema.ts"
    return match.group(1)


def _entries(block: str) -> list[tuple[str, str]]:
    return re.findall(r'([a-zA-Z]+):\s*"([a-z_]+)"', block)


def test_zod_schema_maps_exactly_our_allowed_settings():
    source = SOURCE.read_text()

    bool_settings = set(re.findall(
        r'"([a-zA-Z]+)"', _block(source, r"BOOL_SETTINGS = \[(.*?)\] as const")))
    assert bool_settings

    entries = _entries(_block(source, r"TO_PYTHON: Record<string, string> = \{(.*?)\n\}"))
    assert entries
    keys = {k for k, _ in entries}
    values = [v for _, v in entries]

    # (a) TO_PYTHON's keys are exactly BOOL_SETTINGS plus the non-bool settings.
    assert keys == bool_settings | {"pointsLimit", "chat", "bet", "simulateHlsPlayback"}
    # (b) No two TS keys may collide on one Python name.
    assert len(values) == len(set(values))
    # (c) The Python-side names match ALLOWED_SETTINGS exactly.
    assert set(values) == set(ALLOWED_SETTINGS)


def test_nested_maps_match_the_allowed_nested_keys():
    source = SOURCE.read_text()
    nested = _block(
        source, r"NESTED_TO_PYTHON: Record<string, Record<string, string>> = \{(.*?)\n\};")

    bet = _entries(_block(nested, r"bet: \{(.*?)\},\n"))
    assert {v for _, v in bet} == set(ALLOWED_BET)

    filt = _entries(_block(nested, r"filterCondition: \{(.*?)\},"))
    assert {v for _, v in filt} == set(ALLOWED_FILTER)

    hls = _entries(_block(nested, r"simulateHlsPlayback: \{(.*?)\},"))
    assert {v for _, v in hls} == {"refresh_before"}
```

- [ ] **Step 2: Run it to verify it passes against Tasks 1-2**

Run: `uv run pytest python/tests/test_schema_parity.py -v`
Expected: PASS. (This test guards work already done; if it fails, the mismatch it names is a real bug in Task 1 or 2 — fix that, not the test.)

- [ ] **Step 3: Verify it actually catches drift**

Temporarily add `"bogusKey": "bogus_key",` to `TO_PYTHON` in `apps/backend/src/config/schema.ts`, re-run the test, confirm it FAILS on assertion (a), then revert the edit.

Run: `uv run pytest python/tests/test_schema_parity.py -v`
Expected after revert: PASS.

- [ ] **Step 4: Commit**

```bash
git add python/tests/test_schema_parity.py
git commit -m "test: extend schema parity to the nested settings maps"
```

---

## Task 5: The field table

**Files:**
- Create: `apps/frontend/src/lib/settingsFields.ts`
- Test: `apps/frontend/src/lib/settingsFields.test.ts`

**Interfaces:**
- Consumes: the camelCase key names from Task 1.
- Produces:
  ```ts
  export type FieldKind =
    | { kind: "bool" }
    | { kind: "enum"; options: readonly string[]; labels?: Record<string, string> }
    | { kind: "optionalNumber"; offValue: false; min?: number }
    | { kind: "number"; min?: number; max?: number };
  export interface SettingsField {
    key: string; label: string; help: string; tab: TabId;
    kind: FieldKind; defaultValue: unknown;
  }
  export type TabId = "general" | "points" | "predictions";
  export const SETTINGS_FIELDS: SettingsField[];
  export const BET_FIELDS: SettingsField[];
  export function describeDefault(field: SettingsField): string;
  ```
  Tasks 6, 7 and 8 render from these.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/lib/settingsFields.test.ts`:

```ts
import { expect, test } from "vitest";
import { BET_FIELDS, SETTINGS_FIELDS, describeDefault } from "./settingsFields.js";

test("covers every upstream StreamerSettings field", () => {
  expect(new Set(SETTINGS_FIELDS.map((f) => f.key))).toEqual(new Set([
    "makePredictions", "followRaid", "claimDrops", "claimMoments",
    "watchStreak", "communityGoals", "weeklyRewards",
    "pointsLimit", "chat", "simulateHlsPlayback",
  ]));
});

test("covers every BetSettings field", () => {
  expect(new Set(BET_FIELDS.map((f) => f.key))).toEqual(new Set([
    "strategy", "percentage", "percentageGap", "maxPoints",
    "minimumPoints", "stealthMode", "delay", "delayMode",
  ]));
});

test("carries upstream's own defaults, including the false ones", () => {
  const by = (key: string) =>
    [...SETTINGS_FIELDS, ...BET_FIELDS].find((f) => f.key === key);
  expect(by("watchStreak")?.defaultValue).toBe(true);
  expect(by("communityGoals")?.defaultValue).toBe(false);
  expect(by("pointsLimit")?.defaultValue).toBe(false);
  expect(by("chat")?.defaultValue).toBe("ONLINE");
  expect(by("strategy")?.defaultValue).toBe("SMART");
  expect(by("delayMode")?.defaultValue).toBe("FROM_END");
  expect(by("minimumPoints")?.defaultValue).toBe(0);
});

test("describes a default in words a person can read", () => {
  const by = (key: string) => SETTINGS_FIELDS.find((f) => f.key === key)!;
  expect(describeDefault(by("watchStreak"))).toBe("On");
  expect(describeDefault(by("communityGoals"))).toBe("Off");
  expect(describeDefault(by("pointsLimit"))).toBe("No limit");
  expect(describeDefault(by("chat"))).toBe("Online");
});

test("every field has help text, so no control ships unexplained", () => {
  for (const field of [...SETTINGS_FIELDS, ...BET_FIELDS]) {
    expect(field.help.length).toBeGreaterThan(0);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/frontend && npx vitest run src/lib/settingsFields.test.ts`
Expected: FAIL — cannot resolve `./settingsFields.js`.

- [ ] **Step 3: Implement**

Create `apps/frontend/src/lib/settingsFields.ts`. Every `defaultValue` is upstream's own, from `StreamerSettings.default()` and `BetSettings.default()`:

```ts
export type TabId = "general" | "points" | "predictions";

export type FieldKind =
  | { kind: "bool" }
  | { kind: "enum"; options: readonly string[]; labels?: Record<string, string> }
  | { kind: "optionalNumber"; offValue: false; min?: number; offLabel: string }
  | { kind: "number"; min?: number; max?: number };

export interface SettingsField {
  key: string;
  label: string;
  help: string;
  tab: TabId;
  kind: FieldKind;
  defaultValue: unknown;
}

const bool = (
  key: string, label: string, help: string, tab: TabId, defaultValue: boolean,
): SettingsField => ({ key, label, help, tab, kind: { kind: "bool" }, defaultValue });

export const SETTINGS_FIELDS: SettingsField[] = [
  bool("makePredictions", "Make predictions",
    "Place channel-point bets on this streamer's predictions.", "general", true),
  bool("followRaid", "Follow raids",
    "Join raids from this channel to collect the raid bonus.", "general", true),
  bool("claimDrops", "Claim drops",
    "Count viewing time towards Twitch drop campaigns.", "general", true),
  bool("claimMoments", "Claim moments",
    "Claim Twitch Moments when this channel publishes one.", "general", true),
  bool("watchStreak", "Watch streaks",
    "Prioritise this channel when a watch streak is available.", "general", true),
  bool("communityGoals", "Community goals",
    "Contribute the maximum points per stream to community challenge goals.",
    "general", false),
  bool("weeklyRewards", "Weekly rewards",
    "Automatically progress this channel's weekly rewards.", "general", true),
  {
    key: "pointsLimit", label: "Points limit", tab: "points",
    help: "Stop mining this channel once its balance reaches this many points.",
    kind: { kind: "optionalNumber", offValue: false, min: 1, offLabel: "No limit" },
    defaultValue: false,
  },
  {
    key: "chat", label: "Chat presence", tab: "points",
    help: "Join the channel's IRC chat to increase watch time.",
    kind: {
      kind: "enum",
      options: ["ALWAYS", "NEVER", "ONLINE", "OFFLINE"],
      labels: { ALWAYS: "Always", NEVER: "Never", ONLINE: "Online", OFFLINE: "Offline" },
    },
    defaultValue: "ONLINE",
  },
  {
    key: "simulateHlsPlayback", label: "Simulate playback", tab: "points",
    help: "Fetch the stream like a real player, refreshing the access token this "
      + "many seconds before it expires. Off skips HLS simulation entirely.",
    kind: { kind: "optionalNumber", offValue: false, min: 1, offLabel: "Off" },
    defaultValue: false,
  },
];

export const BET_FIELDS: SettingsField[] = [
  {
    key: "strategy", label: "Strategy", tab: "predictions",
    help: "How to pick which outcome to bet on.",
    kind: {
      kind: "enum",
      options: ["MOST_VOTED", "HIGH_ODDS", "PERCENTAGE", "SMART_MONEY", "SMART",
        "NUMBER_1", "NUMBER_2", "NUMBER_3", "NUMBER_4",
        "NUMBER_5", "NUMBER_6", "NUMBER_7", "NUMBER_8"],
      labels: {
        MOST_VOTED: "Most voted", HIGH_ODDS: "High odds", PERCENTAGE: "Percentage",
        SMART_MONEY: "Smart money", SMART: "Smart",
        NUMBER_1: "Outcome 1", NUMBER_2: "Outcome 2", NUMBER_3: "Outcome 3",
        NUMBER_4: "Outcome 4", NUMBER_5: "Outcome 5", NUMBER_6: "Outcome 6",
        NUMBER_7: "Outcome 7", NUMBER_8: "Outcome 8",
      },
    },
    defaultValue: "SMART",
  },
  {
    key: "percentage", label: "Percentage", tab: "predictions",
    help: "Bet this percentage of your balance on the channel.",
    kind: { kind: "number", min: 0, max: 100 }, defaultValue: 5,
  },
  {
    key: "percentageGap", label: "Percentage gap", tab: "predictions",
    help: "Minimum gap between outcomes before the Smart strategy commits.",
    kind: { kind: "number", min: 0, max: 100 }, defaultValue: 20,
  },
  {
    key: "maxPoints", label: "Maximum points", tab: "predictions",
    help: "Cap on a single bet, whatever the percentage works out to.",
    kind: { kind: "number", min: 0 }, defaultValue: 50000,
  },
  {
    key: "minimumPoints", label: "Minimum balance", tab: "predictions",
    help: "Only bet when the channel balance is at least this high.",
    kind: { kind: "number", min: 0 }, defaultValue: 0,
  },
  bool("stealthMode", "Stealth mode",
    "Never out-bet the current top predictor; place just under instead.",
    "predictions", false),
  {
    key: "delay", label: "Delay", tab: "predictions",
    help: "Seconds used with the delay mode below to time the bet.",
    kind: { kind: "number", min: 0 }, defaultValue: 6,
  },
  {
    key: "delayMode", label: "Delay mode", tab: "predictions",
    help: "Whether the delay counts from the start of the window, from its end, "
      + "or as a fraction of it.",
    kind: {
      kind: "enum",
      options: ["FROM_START", "FROM_END", "PERCENTAGE"],
      labels: { FROM_START: "From start", FROM_END: "From end", PERCENTAGE: "Percentage" },
    },
    defaultValue: "FROM_END",
  },
];

/** Renders a field's upstream default as display text. */
export function describeDefault(field: SettingsField): string {
  const value = field.defaultValue;
  if (field.kind.kind === "optionalNumber" && value === false) {
    return field.kind.offLabel;
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (field.kind.kind === "enum") {
    return field.kind.labels?.[String(value)] ?? String(value);
  }
  return String(value);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/frontend && npx vitest run src/lib/settingsFields.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/settingsFields.ts apps/frontend/src/lib/settingsFields.test.ts
git commit -m "feat(settings): describe every streamer setting in one table"
```

---

## Task 6: The field row, with inherit-vs-override

**Files:**
- Create: `apps/frontend/src/components/SettingsFieldRow.tsx`
- Test: `apps/frontend/src/components/SettingsFieldRow.test.tsx`

**Interfaces:**
- Consumes: `SettingsField`, `describeDefault` from Task 5.
- Produces:
  ```ts
  export interface SettingsFieldRowProps {
    field: SettingsField;
    value: unknown;              // undefined = not set
    inheritedValue?: unknown;    // what applies when value is undefined
    canInherit: boolean;         // false on the global-defaults screen
    disabled?: boolean;
    onChange: (value: unknown) => void;  // undefined clears the key
  }
  ```
  Tasks 7 and 8 render this.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/SettingsFieldRow.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { SettingsFieldRow } from "./SettingsFieldRow.js";
import { BET_FIELDS, SETTINGS_FIELDS } from "../lib/settingsFields.js";
import { renderApp } from "../test-utils.js";

const field = (key: string) =>
  [...SETTINGS_FIELDS, ...BET_FIELDS].find((f) => f.key === key)!;

test("shows the inherited value while the field is unset", () => {
  renderApp(
    <SettingsFieldRow
      field={field("watchStreak")} value={undefined} inheritedValue={true}
      canInherit onChange={() => {}}
    />,
  );
  expect(screen.getByTestId("field-state")).toHaveTextContent("Inherit");
  expect(screen.getByTestId("field-state")).toHaveTextContent("On");
});

test("overriding emits the inherited value, so nothing changes by surprise", async () => {
  const onChange = vi.fn();
  renderApp(
    <SettingsFieldRow
      field={field("watchStreak")} value={undefined} inheritedValue={true}
      canInherit onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: /override/i }));
  expect(onChange).toHaveBeenCalledWith(true);
});

test("resetting clears the key rather than writing a value", async () => {
  const onChange = vi.fn();
  renderApp(
    <SettingsFieldRow
      field={field("watchStreak")} value={false} inheritedValue={true}
      canInherit onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: /override/i }));
  expect(onChange).toHaveBeenCalledWith(undefined);
});

test("an overridden false is not mistaken for unset", () => {
  renderApp(
    <SettingsFieldRow
      field={field("watchStreak")} value={false} inheritedValue={true}
      canInherit onChange={() => {}}
    />,
  );
  expect(screen.getByTestId("field-state")).toHaveTextContent("Overridden");
  expect(screen.getByRole("switch", { name: "Watch streaks" })).not.toBeChecked();
});

test("an enum field offers every option and reports the chosen one", async () => {
  const onChange = vi.fn();
  renderApp(
    <SettingsFieldRow
      field={field("chat")} value="ONLINE" canInherit={false} onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Chat presence" }));
  // Mantine portals the dropdown into a display:none wrapper, so Testing
  // Library filters the options out unless hidden:true. See the plan header.
  expect(screen.getAllByRole("option", { hidden: true })).toHaveLength(4);
  await userEvent.click(screen.getByRole("option", { name: "Never", hidden: true }));
  expect(onChange).toHaveBeenCalledWith("NEVER");
});

test("an optional number switches between off and a value", async () => {
  const onChange = vi.fn();
  renderApp(
    <SettingsFieldRow
      field={field("pointsLimit")} value={false} canInherit={false} onChange={onChange}
    />,
  );
  expect(screen.queryByRole("textbox", { name: "Points limit" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("switch", { name: /points limit/i }));
  expect(onChange).toHaveBeenCalledWith(1);
});

test("shows the upstream default as placeholder text when it cannot inherit", () => {
  renderApp(
    <SettingsFieldRow
      field={field("communityGoals")} value={undefined} canInherit={false}
      onChange={() => {}}
    />,
  );
  expect(screen.getByTestId("field-state")).toHaveTextContent("Off");
});

test("a disabled row cannot be edited", async () => {
  const onChange = vi.fn();
  renderApp(
    <SettingsFieldRow
      field={field("stealthMode")} value={true} canInherit={false} disabled
      onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Stealth mode" }));
  expect(onChange).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/frontend && npx vitest run src/components/SettingsFieldRow.test.tsx`
Expected: FAIL — cannot resolve `./SettingsFieldRow.js`.

- [ ] **Step 3: Implement**

Create `apps/frontend/src/components/SettingsFieldRow.tsx`:

```tsx
import { Badge, Group, NumberInput, Select, Stack, Switch, Text } from "@mantine/core";
import { type SettingsField, describeDefault } from "../lib/settingsFields.js";

export interface SettingsFieldRowProps {
  field: SettingsField;
  /** `undefined` means the key is absent -- inherited, never a sentinel. */
  value: unknown;
  inheritedValue?: unknown;
  canInherit: boolean;
  disabled?: boolean;
  /** Called with `undefined` to clear the key. */
  onChange: (value: unknown) => void;
}

/** What applies right now: the override if set, else what it inherits. */
function effectiveValue(props: SettingsFieldRowProps): unknown {
  if (props.value !== undefined) return props.value;
  return props.canInherit ? props.inheritedValue : props.field.defaultValue;
}

function describeValue(field: SettingsField, value: unknown): string {
  if (field.kind.kind === "optionalNumber" && value === false) {
    return field.kind.offLabel;
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (field.kind.kind === "enum") {
    return field.kind.labels?.[String(value)] ?? String(value);
  }
  return value === undefined ? describeDefault(field) : String(value);
}

export function SettingsFieldRow(props: SettingsFieldRowProps) {
  const { field, value, canInherit, disabled, onChange } = props;
  const overridden = value !== undefined;
  const current = effectiveValue(props);

  const control = () => {
    // An inherit-capable field that is not overridden shows its resolved
    // value as text: an editable control there would imply the edit sticks.
    if (canInherit && !overridden) {
      return <Text size="sm" c="dimmed">{describeValue(field, current)}</Text>;
    }
    switch (field.kind.kind) {
      case "bool":
        return (
          <Switch
            aria-label={field.label}
            checked={current === true}
            disabled={disabled}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        );
      case "enum":
        return (
          <Select
            aria-label={field.label}
            data={field.kind.options.map((v) => ({
              value: v, label: field.kind.kind === "enum"
                ? field.kind.labels?.[v] ?? v : v,
            }))}
            value={typeof current === "string" ? current : null}
            disabled={disabled}
            allowDeselect={false}
            onChange={(v) => v !== null && onChange(v)}
            w={180}
          />
        );
      case "number":
        return (
          <NumberInput
            aria-label={field.label}
            value={typeof current === "number" ? current : ""}
            min={field.kind.min} max={field.kind.max}
            disabled={disabled}
            onChange={(v) => onChange(typeof v === "number" ? v : undefined)}
            w={120}
          />
        );
      case "optionalNumber": {
        const off = current === false || current === undefined;
        return (
          <Group gap="xs" wrap="nowrap">
            <Switch
              aria-label={`${field.label} enabled`}
              checked={!off}
              disabled={disabled}
              onChange={(e) =>
                onChange(e.currentTarget.checked ? (field.kind.kind === "optionalNumber"
                  ? field.kind.min ?? 1 : 1) : false)}
            />
            {!off && (
              <NumberInput
                aria-label={field.label}
                value={typeof current === "number" ? current : ""}
                min={field.kind.min}
                disabled={disabled}
                onChange={(v) => onChange(typeof v === "number" ? v : false)}
                w={120}
              />
            )}
          </Group>
        );
      }
    }
  };

  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap" py={6}>
      <Stack gap={2} style={{ flex: 1 }}>
        <Group gap="xs">
          <Text size="sm" fw={500}>{field.label}</Text>
          <Badge
            size="xs" variant="light" data-testid="field-state"
            color={overridden ? "twitch" : "gray"}
          >
            {canInherit
              ? (overridden ? "Overridden" : `Inherit — ${describeValue(field, current)}`)
              : describeValue(field, current)}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed">{field.help}</Text>
      </Stack>
      <Group gap="sm" wrap="nowrap">
        {control()}
        {canInherit && (
          <Switch
            aria-label={`Override ${field.label}`}
            checked={overridden}
            disabled={disabled}
            onChange={(e) =>
              onChange(e.currentTarget.checked ? effectiveValue(props) : undefined)}
          />
        )}
      </Group>
    </Group>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/frontend && npx vitest run src/components/SettingsFieldRow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/SettingsFieldRow.tsx apps/frontend/src/components/SettingsFieldRow.test.tsx
git commit -m "feat(settings): add a field row with inherit and override"
```

---

## Task 7: The per-streamer dialog

**Files:**
- Create: `apps/frontend/src/components/StreamerSettingsModal.tsx`
- Test: `apps/frontend/src/components/StreamerSettingsModal.test.tsx`
- Modify: `apps/frontend/src/components/StreamerRow.tsx` (gear button; stale comment at `:138`)
- Modify: `apps/frontend/src/routes/Streamers.tsx` (modal state; stale comment at `:178`)

**Interfaces:**
- Consumes: `SettingsFieldRow` (Task 6), `SETTINGS_FIELDS`/`BET_FIELDS` (Task 5).
- Produces:
  ```ts
  export interface StreamerSettingsModalProps {
    username: string;
    opened: boolean;
    settings: Record<string, unknown>;
    defaults: Record<string, unknown>;
    onChange: (settings: Record<string, unknown>) => void;
    onClose: () => void;
  }
  ```
  `StreamerRow` gains `onOpenSettings: () => void`.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/StreamerSettingsModal.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { StreamerSettingsModal } from "./StreamerSettingsModal.js";
import { renderApp } from "../test-utils.js";

const view = (over: Partial<React.ComponentProps<typeof StreamerSettingsModal>> = {}) => {
  const onChange = vi.fn();
  renderApp(
    <StreamerSettingsModal
      username="alpha" opened settings={{}} defaults={{}}
      onChange={onChange} onClose={() => {}} {...over}
    />,
  );
  return onChange;
};

test("names the streamer it is editing", () => {
  view();
  expect(screen.getByText(/alpha/)).toBeInTheDocument();
});

test("editing a field writes only that key", async () => {
  const onChange = view();
  await userEvent.click(screen.getByRole("switch", { name: "Override Watch streaks" }));
  expect(onChange).toHaveBeenCalledWith({ watchStreak: true });
});

test("clearing an override removes the key entirely", async () => {
  const onChange = view({ settings: { watchStreak: false } });
  await userEvent.click(screen.getByRole("switch", { name: "Override Watch streaks" }));
  expect(onChange).toHaveBeenCalledWith({});
});

test("inherits from the global defaults, not just upstream's", () => {
  view({ defaults: { watchStreak: false } });
  const badges = screen.getAllByTestId("field-state");
  expect(badges.some((b) => b.textContent?.includes("Inherit — Off"))).toBe(true);
});

test("bet fields live under the predictions tab and nest under bet", async () => {
  const onChange = view({ settings: { makePredictions: true } });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  await userEvent.click(screen.getByRole("switch", { name: "Override Strategy" }));
  expect(onChange).toHaveBeenCalledWith({
    makePredictions: true, bet: { strategy: "SMART" },
  });
});

test("predictions are disabled when the streamer does not bet", async () => {
  view({ settings: { makePredictions: false } });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  expect(screen.getByTestId("predictions-disabled-note")).toBeInTheDocument();
});

test("a filter condition is only written once enabled", async () => {
  const onChange = view({ settings: { makePredictions: true } });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  await userEvent.click(screen.getByRole("switch", { name: /only bet when/i }));
  expect(onChange).toHaveBeenCalledWith({
    makePredictions: true,
    bet: { filterCondition: { by: "total_users", where: "LTE", value: 800 } },
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/frontend && npx vitest run src/components/StreamerSettingsModal.test.tsx`
Expected: FAIL — cannot resolve `./StreamerSettingsModal.js`.

- [ ] **Step 3: Implement the modal**

Create `apps/frontend/src/components/StreamerSettingsModal.tsx`:

```tsx
import { Alert, Modal, Stack, Switch, Tabs, Text } from "@mantine/core";
import { BET_FIELDS, SETTINGS_FIELDS, type TabId } from "../lib/settingsFields.js";
import { SettingsFieldRow } from "./SettingsFieldRow.js";

export interface StreamerSettingsModalProps {
  username: string;
  opened: boolean;
  settings: Record<string, unknown>;
  defaults: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
  onClose: () => void;
}

const DEFAULT_FILTER = { by: "total_users", where: "LTE", value: 800 };

/** Sets or, for `undefined`, deletes a key -- absent means inherited. */
function withKey(
  source: Record<string, unknown>, key: string, value: unknown,
): Record<string, unknown> {
  const next = { ...source };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

export function StreamerSettingsModal(props: StreamerSettingsModalProps) {
  const { username, opened, settings, defaults, onChange, onClose } = props;

  const bet = (settings.bet ?? {}) as Record<string, unknown>;
  const defaultBet = (defaults.bet ?? {}) as Record<string, unknown>;
  const filter = bet.filterCondition as Record<string, unknown> | undefined;

  const setBet = (key: string, value: unknown) => {
    const nextBet = withKey(bet, key, value);
    onChange(withKey(settings, "bet",
      Object.keys(nextBet).length > 0 ? nextBet : undefined));
  };

  // Predictions are meaningless when the streamer does not bet. The
  // resolved value decides, so inheriting `false` disables them too.
  const bets = (settings.makePredictions ?? defaults.makePredictions ?? true) === true;

  const rows = (tab: TabId) =>
    SETTINGS_FIELDS.filter((f) => f.tab === tab).map((field) => (
      <SettingsFieldRow
        key={field.key}
        field={field}
        value={settings[field.key]}
        inheritedValue={defaults[field.key] ?? field.defaultValue}
        canInherit
        onChange={(v) => onChange(withKey(settings, field.key, v))}
      />
    ));

  return (
    <Modal opened={opened} onClose={onClose} title={`Settings — ${username}`} size="lg">
      <Tabs defaultValue="general">
        <Tabs.List>
          <Tabs.Tab value="general">General</Tabs.Tab>
          <Tabs.Tab value="points">Points &amp; chat</Tabs.Tab>
          <Tabs.Tab value="predictions">Predictions</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="general"><Stack gap={0} pt="md">{rows("general")}</Stack></Tabs.Panel>
        <Tabs.Panel value="points"><Stack gap={0} pt="md">{rows("points")}</Stack></Tabs.Panel>

        <Tabs.Panel value="predictions">
          <Stack gap={0} pt="md">
            {!bets && (
              <Alert color="gray" data-testid="predictions-disabled-note" mb="sm">
                Predictions are off for this streamer. Turn on “Make predictions”
                under General to configure betting.
              </Alert>
            )}
            {BET_FIELDS.map((field) => (
              <SettingsFieldRow
                key={field.key}
                field={field}
                value={bet[field.key]}
                inheritedValue={defaultBet[field.key] ?? field.defaultValue}
                canInherit
                disabled={!bets}
                onChange={(v) => setBet(field.key, v)}
              />
            ))}
            <Switch
              mt="md"
              label="Only bet when…"
              description="Skip the bet unless the outcome matches this condition."
              checked={filter !== undefined}
              disabled={!bets}
              onChange={(e) =>
                setBet("filterCondition", e.currentTarget.checked ? DEFAULT_FILTER : undefined)}
            />
            {filter && (
              <Text size="xs" c="dimmed" mt="xs">
                {String(filter.by)} {String(filter.where)} {String(filter.value)}
              </Text>
            )}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/frontend && npx vitest run src/components/StreamerSettingsModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire it into the streamer list**

In `apps/frontend/src/components/StreamerRow.tsx`, add `onOpenSettings: () => void;` to `Props`, destructure it, and add a gear button beside the remove button (import `IconSettings` from `@tabler/icons-react`). Mantine `Tooltip` is cleared for use now, so use one rather than `title`:

```tsx
          <Tooltip label={`Settings for ${username}`}>
            <ActionIcon
              variant="subtle" color="gray"
              onClick={onOpenSettings}
              aria-label={`Settings for ${username}`}
            >
              <IconSettings size={16} />
            </ActionIcon>
          </Tooltip>
```

Replace the stale comment above the remove button (`:138`, "…`title` rather than a Mantine `<Tooltip>`, which hangs the vitest worker.") with:

```tsx
          {/* Removal is staged like every other edit on this screen -- it
              drops the row from the draft and the pending bar counts it, so
              a stray click costs an Apply, not a config. */}
```

In `apps/frontend/src/routes/Streamers.tsx`: add `const [editing, setEditing] = useState<number | null>(null);`, pass `onOpenSettings={() => setEditing(index)}` to each `StreamerRow`, and render the modal after the `DndContext`:

```tsx
      {editing !== null && draft.streamers[editing] && (
        <StreamerSettingsModal
          opened
          username={draft.streamers[editing].username}
          settings={draft.streamers[editing].settings}
          defaults={draft.defaults}
          onClose={() => setEditing(null)}
          onChange={(settings) => setDraft({
            ...draft,
            streamers: draft.streamers.map((s, i) =>
              i === editing ? { ...s, settings } : s),
          })}
        />
      )}
```

Replace the stale Tooltip comment at `:178` with `{/* Refresh the live snapshot without touching the staged draft. */}`.

- [ ] **Step 6: Run the affected suites**

Run: `cd apps/frontend && npx vitest run src/routes/Streamers.test.tsx src/components/`
Expected: PASS. `countChanges` already deep-compares with `JSON.stringify`, so a settings edit is counted without further change.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/components/StreamerSettingsModal.tsx apps/frontend/src/components/StreamerSettingsModal.test.tsx apps/frontend/src/components/StreamerRow.tsx apps/frontend/src/routes/Streamers.tsx
git commit -m "feat(streamers): edit every setting per streamer in a dialog"
```

---

## Task 8: Global defaults and miner-wide options on the Settings page

**Files:**
- Modify: `apps/frontend/src/routes/Settings.tsx`
- Test: `apps/frontend/src/routes/Settings.test.tsx`
- Modify: `apps/frontend/src/routes/Dashboard.tsx:210-212` (stale comment only)

**Interfaces:**
- Consumes: `SettingsFieldRow` (Task 6), the field tables (Task 5), the `miner` shape (Task 3).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

`apps/frontend/src/routes/Settings.test.tsx` already has the fixture and
`fetch` stub these tests need: a module-scope `config` object, a `calls`
array recording every request, and a local `view()` helper that renders
`<Settings />` inside a bare `<MantineProvider>`. Two edits first — add
`miner: {},` to the `config` fixture (the page now reads it), and use that
file's own `view()` rather than `renderApp` in the new tests below, to match
the surrounding style. Then add:

```tsx
test("edits a global default and stages it", async () => {
  view();
  await screen.findByText("Mine my followed channels");
  await userEvent.click(screen.getByRole("switch", { name: "Community goals" }));
  await userEvent.click(screen.getByRole("button", { name: /apply/i }));
  await waitFor(() => {
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body)).defaults.communityGoals).toBe(true);
  });
});

test("global defaults have no inherit control -- they are the defaults", async () => {
  view();
  await screen.findByText("Mine my followed channels");
  expect(screen.queryByRole("switch", { name: /^Override/ })).not.toBeInTheDocument();
});

test("stages the miner-wide priority order", async () => {
  view();
  await screen.findByText("Mine my followed channels");
  await userEvent.click(screen.getByRole("checkbox", { name: "Watch streaks" }));
  await userEvent.click(screen.getByRole("button", { name: /apply/i }));
  await waitFor(() => {
    const put = calls.find((c) => c.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body)).miner.priority).toContain("STREAK");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/frontend && npx vitest run src/routes/Settings.test.tsx`
Expected: FAIL — no such switch on the page.

- [ ] **Step 3: Implement**

In `apps/frontend/src/routes/Settings.tsx`: add `miner: Record<string, unknown>;` to the `Config` interface; widen `changed` to `JSON.stringify(draft) !== JSON.stringify(saved)`; and add two cards after the existing ones.

Global defaults — the same rows with `canInherit={false}`, grouped by tab, plus the bet fields:

```tsx
      <Card withBorder padding="md">
        <Title order={4} mb="xs">Default streamer settings</Title>
        <Text size="sm" c="dimmed" mb="md">
          Applied to every streamer that does not override the setting itself.
        </Text>
        <Stack gap={0}>
          {SETTINGS_FIELDS.map((field) => (
            <SettingsFieldRow
              key={field.key} field={field} value={draft.defaults[field.key]}
              canInherit={false}
              onChange={(v) => setDraft({
                ...draft, defaults: withKey(draft.defaults, field.key, v),
              })}
            />
          ))}
        </Stack>
      </Card>
```

Miner-wide — priority as a `Checkbox.Group` (order of selection is the priority order), plus `claimDropsStartup`:

```tsx
      <Card withBorder padding="md">
        <Title order={4} mb="xs">Miner</Title>
        <Checkbox.Group
          label="Priority"
          description="What the miner reaches for first when choosing which channels to watch. Leave all unchecked for the built-in order."
          value={(draft.miner.priority as string[]) ?? []}
          onChange={(value) => setDraft({
            ...draft, miner: withKey(draft.miner, "priority",
              value.length > 0 ? value : undefined),
          })}
        >
          <Stack gap="xs" mt="sm">
            {PRIORITY_LABELS.map(([value, label]) => (
              <Checkbox key={value} value={value} label={label} />
            ))}
          </Stack>
        </Checkbox.Group>
        <Switch
          mt="md"
          label="Claim drops at startup"
          description="Claim everything claimable in your Twitch inventory when the miner starts."
          checked={draft.miner.claimDropsStartup === true}
          onChange={(e) => setDraft({
            ...draft,
            miner: withKey(draft.miner, "claimDropsStartup",
              e.currentTarget.checked || undefined),
          })}
        />
      </Card>
```

Define at module scope, with `withKey` copied from the modal (or exported from it and imported — pick one and use it in both places):

```tsx
const PRIORITY_LABELS: Array<[string, string]> = [
  ["STREAK", "Watch streaks"], ["DROPS", "Drops"], ["SUBSCRIBED", "Subscribed"],
  ["WATCH_SESSION", "Watch session"], ["WEEKLY_REWARDS", "Weekly rewards"],
  ["ORDER", "List order"], ["POINTS_ASCENDING", "Fewest points first"],
  ["POINTS_DESCENDING", "Most points first"],
];
```

In `apps/frontend/src/routes/Dashboard.tsx`, replace the stale clause at `:210-212` ("Mantine's Combobox also renders enough inline CSS to stall vitest's reporter channel in CI, which made the whole test file look hung.") so only the still-true reason remains: `{/* A native select is the better control on a phone and by keyboard. */}`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/frontend && npx vitest run src/routes/Settings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full suite and type-check**

Run: `pnpm test && pnpm run build && uv run pytest`
Expected: all green, build exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/routes/Settings.tsx apps/frontend/src/routes/Settings.test.tsx apps/frontend/src/routes/Dashboard.tsx
git commit -m "feat(settings): edit global defaults and the miner-wide options"
```

---

## Task 9: Document manual notification setup

**Files:**
- Modify: `README.md` (new subsection under "How it works", which ends at the "Development" heading)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Write the section**

Add to `README.md` after the "How it works" section:

```markdown
### Notifications

The miner can push events to Telegram, Discord, Matrix, Pushover, Gotify or a
plain webhook. Those are deliberately **not** configurable from the web UI:
they carry bot tokens and webhook URLs, and this app serves a single shared
password over plain HTTP on your LAN. Set them by hand instead.

Edit the `LoggerSettings(...)` block in `python/run.py`:

    logger_settings=LoggerSettings(
        save=True,
        console_level=20,
        file_level=_file_level(),
        hooks=[DoorbellHook(DOORBELL_URL, DOORBELL_TOKEN)],
        telegram=Telegram(
            chat_id=123456789,
            token="123456789:your-bot-token",
            events=[Events.STREAMER_ONLINE, Events.BET_LOSE],
        ),
    ),

importing whichever integrations you use from
`TwitchChannelPointsMiner.classes` (`Telegram`, `Discord`, `Webhook`,
`Matrix`, `Pushover`, `Gotify`) and `Events` from
`TwitchChannelPointsMiner.classes.Settings`. Keep the existing `hooks=[...]`
entry: upstream appends the named integrations to that list rather than
replacing it, so the app's own event feed keeps working alongside yours.

Restart the miner from the dashboard to pick the change up.

**If you run the published image**, `run.py` lives inside it and your edit is
lost on the next `docker compose pull`. Copy the file out once and mount your
copy over it:

    docker compose cp twitch-miner-control:/app/python/run.py ./run.py

then add to your `compose.yaml`:

    volumes:
      - ./data:/data
      - ./run.py:/app/python/run.py:ro

Re-copy the file after an upgrade that changes `run.py` upstream, or your
pinned copy will keep overriding the new one.
```

- [ ] **Step 2: Verify the commands are accurate**

Run: `grep -n "LoggerSettings\|DoorbellHook" python/run.py`
Expected: confirms the block quoted above matches the real file. Read `docker/Dockerfile` and confirm `COPY python python` still places `run.py` at `/app/python/run.py`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: explain how to set up notifications by hand"
```

---

## Self-Review

**Spec coverage:** all 11 per-streamer fields (Tasks 1, 2, 5, 6, 7); inheritance model (Task 6, with absent-key semantics asserted); tabbed dialog (Task 7); global defaults + miner-wide section on one Settings page (Task 8); recursive mappers (Task 1); `ALLOWED_SETTINGS` growth and nested construction (Task 2); miner-wide options through to `run.py` (Task 3); parity test (Task 4); the `BasicConfiguration` field-name trap pinned (Task 3); three stale comments corrected (Tasks 7 and 8); notification docs (Task 9). Notifications, `ColorPalette`, `anonymiser`, `watch_streak_recovery` and the app-level flags are absent by design.

**Type consistency:** `settingsToPython`/`settingsFromPython` keep their exported names and gain recursion; `renameKeys`/`invert` are defined once and used by both mapper pairs; `SettingsField`/`FieldKind`/`describeDefault` (Task 5) are consumed unchanged by Tasks 6-8; `withKey` is shared between the modal and the Settings page; `StreamerRow` gains exactly `onOpenSettings`.

**Known follow-up:** a per-streamer `bet` replaces the default `bet` wholesale rather than merging key-by-key, because `_settings` does a shallow dict merge. Task 2 pins that as deliberate in `test_per_streamer_bet_replaces_the_default_bet_wholesale`. If per-key bet inheritance is wanted later, it is a change to `_settings` plus the modal's `inheritedValue` wiring.
