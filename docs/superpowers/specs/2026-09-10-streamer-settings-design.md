# Full streamer & miner settings in the UI

Status: proposed
Date: 2026-09-10

## Problem

Miner Control exists to replace hand-editing upstream's `run.py`, but most
of what `run.py` configures is still unreachable from the browser.

Two separate gaps:

1. **Per-streamer settings are plumbed but uneditable.** `config.json`,
   the Zod schema and `miner_config.py` all support `defaults` and
   per-streamer `settings`, and nine of upstream's eleven
   `StreamerSettings` fields already round-trip. Nothing in the UI writes
   them: `Streamers.tsx` only does add/remove/reorder/enable, and
   `Settings.tsx` only edits `followers`/`followersOrder`. Every streamer
   is created with `settings: {}` and stays that way.
2. **Two per-streamer fields and several miner-wide options are absent
   from the contract entirely** — `bet`, `simulate_hls_playback`, and the
   miner-wide knobs hardcoded in `run.py`'s constructor call.

## Scope

### In

Per-streamer (upstream `StreamerSettings`, all 11 fields):

| Field | Type | Default |
|---|---|---|
| `make_predictions` | bool | true |
| `follow_raid` | bool | true |
| `claim_drops` | bool | true |
| `claim_moments` | bool | true |
| `watch_streak` | bool | true |
| `community_goals` | bool | false |
| `weekly_rewards` | bool | true |
| `points_limit` | int \| false | false |
| `chat` | ALWAYS/NEVER/ONLINE/OFFLINE | ONLINE |
| `simulate_hls_playback` | false \| `{refresh_before: int}` | `{refresh_before: 120}` |
| `bet` | `BetSettings` (below) | see below |

`BetSettings`: `strategy` (13 values), `percentage`, `percentage_gap`,
`max_points`, `minimum_points`, `stealth_mode`, `delay`, `delay_mode`
(FROM_START/FROM_END/PERCENTAGE), and optional `filter_condition`
(`by` × `where` × `value`). Defaults from `BetSettings.default()`:
SMART / 5 / 20 / 50000 / 0 / false / 6 / FROM_END.

Miner-wide (currently hardcoded in `run.py`):

- `priority` — list of `Priority` values (ORDER, STREAK, DROPS,
  SUBSCRIBED, POINTS_ASCENDING, POINTS_DESCENDING, WATCH_SESSION,
  WEEKLY_REWARDS). Upstream's default when unset is a `NestedSelector` of
  watch_session → watch_streak → weekly_rewards → drops → order.
- `claim_drops_startup` — bool
- `gql` — `AttemptStrategy(attempts, attempt_interval_seconds)`
- `weekly_rewards` — `BasicConfiguration` (six scalars, see Notes)

Also in scope: recursive snake_case mapping, the parity test that guards
it, and correcting three stale source comments (below).

### Out

- **All notification integrations** — Telegram, Discord, Webhook, Matrix,
  Pushover, Gotify. They carry bot tokens and webhook URLs, and this app
  is LAN-only, no TLS, one shared password. They stay hand-edited in
  `run.py`; documented instead (see "Documentation").
- `ColorPalette`, `anonymiser`, `redact_secrets`, and logger internals the
  app already manages (`file_level` via `MINER_LOG_LEVEL`, `console_level`,
  `hooks`).
- `watch_streak_recovery` — its factory requires a `runner_factory`
  object, which is code, not a serializable value. Its `BasicConfiguration`
  is serializable but reaching it requires constructing the factory, so the
  whole option is out.
- `enable_analytics`, `use_hermes`, `disable_ssl_cert_verification`,
  `disable_at_in_nickname` — deliberate app-level decisions, not user
  settings.

## Design

### Inheritance model

`miner_config._settings` merges `{**defaults, **overrides}`, so
`settings: {}` and `settings: {watch_streak: true}` produce identical
miner behaviour but mean different things. The UI must not collapse them.

Every per-streamer field renders as **Inherit** by default, showing the
resolved value inline — *Inherit — currently On*. An explicit override
switch turns the control live; a per-field reset returns it to Inherit and
**deletes the key** from `settings`, so `settings: {}` stays genuinely
empty for untouched streamers and a later change to a global default still
propagates to them.

Absent keys, never sentinel values: an override of `false` must be
distinguishable from "not set", which a sentinel would destroy.

### Per-streamer dialog

A Mantine `Modal` opened from a gear button on each `StreamerRow`, with
tabs (~20 fields is too many for one flat form):

- **General** — the 7 booleans
- **Points & chat** — `points_limit`, `chat`, `simulate_hls_playback`
- **Predictions** — the `bet` tree; `filter_condition` collapsed behind
  "Only bet when…"; the whole tab disabled when `make_predictions` is off,
  so the complexity appears only when it is relevant

`points_limit` and `simulate_hls_playback` are each "off, or a number":
a switch that reveals a `NumberInput`, mapping off → `false`.

### Global defaults

The same control set, rendered from one shared component, added to
`Settings.tsx` — no Inherit column, since these *are* the defaults; each
field instead shows upstream's built-in default as placeholder text. Plus
a section for the miner-wide options.

Both screens keep the existing staged-edit flow: edit `draft` → `PendingBar`
counts changes → `PUT /api/config` → `POST /api/config/apply` → miner
restarts. No new API surface.

### Contract changes

`settingsToPython`/`settingsFromPython` (`schema.ts:73-85`) are a flat
one-level `Object.entries` rename. `bet` and `filter_condition` are nested
objects with their own snake_case keys (`percentage_gap`, `max_points`,
`delay_mode`, `filter_condition.by/where/value`), which a flat mapper
renames at the top level and silently leaves alone inside — producing a
`config.json` that `_settings` rejects, or worse, partially accepts. Both
functions become recursive over a declared nested key map.

`test_schema_parity.py` regex-scrapes a flat `TO_PYTHON` map; it grows to
walk the nested map and must keep asserting the three-way equality between
`BOOL_SETTINGS`, `TO_PYTHON` and `miner_config.ALLOWED_SETTINGS`.

`ALLOWED_SETTINGS` gains `bet` and `simulate_hls_playback`; `_settings`
gains construction of `BetSettings`, `FilterCondition` and `HLSSettings`
from plain dicts, with enum-name lookups (`Strategy[...]`, `Condition[...]`,
`DelayMode[...]`) mirroring the existing `ChatPresence[...]` handling.

Miner-wide options go in a new top-level `miner` object in `config.json`,
read by `build_mine_kwargs`/`run.py` — not mixed into `defaults`, which
means per-streamer settings.

### Testing

TDD throughout, per the existing suites:

- `store.test.ts` / `schema.ts` — nested round-trip, absent-key semantics,
  rejection of bad enum values and negative numbers
- `test_miner_config.py` — dict → `BetSettings`/`FilterCondition`/
  `HLSSettings`, `points_limit: false` and `simulate_hls_playback: false`
  preserved (not coerced), unknown nested keys rejected
- `test_schema_parity.py` — extended to the nested map
- Frontend — dialog renders, Inherit vs override, reset deletes the key,
  Predictions disabled when `make_predictions` is off, `PendingBar` counts

Mantine `Select`/`Combobox`/`Tooltip` are cleared for use (retested
2026-09-10 on vitest 5 / jsdom 30: full suite 35 files / 309 tests / 22s,
no hangs). One gotcha: Mantine portals the dropdown into a wrapper that
keeps `display: none` while `aria-expanded="true"`, so Testing Library
filters options out — query with `{ hidden: true }`. The Select target is
`role="combobox"`, not `role="textbox"`.

Three stale comments claiming Tooltip hangs the worker get corrected:
`Streamers.tsx:178`, `StreamerRow.tsx:138`, `Dashboard.tsx:210-212`. The
Dashboard `NativeSelect` stays — it has a second, still-valid reason
(native control on phones).

### Documentation

A README section under "How it works" covering manual notification setup:
which `LoggerSettings` block to edit in `run.py`, and the compose override
that bind-mounts it —

    volumes:
      - ./run.py:/app/python/run.py:ro

Necessary because the published image bakes `run.py` in via
`COPY python python` (`docker/Dockerfile:69`) with only `/data` mounted, so
an in-container edit is lost on the next `docker compose pull`. Note that
upstream's `LoggerSettings.__init__` appends the named integrations onto
`hooks` (`logger.py:131-134`), so a user's `telegram=Telegram(...)` sits
alongside this app's `DoorbellHook` rather than replacing it — the event
feed keeps working.

## Notes

`example.py` documents `WeeklyRewardsProgressor.BasicConfiguration` with
field names that do not exist: it shows `max_concurrent_watch`,
`max_seconds_clips`, `max_seconds_vods`, `loop_interval_seconds`, but the
dataclass (`ClipVodWatcher.py:46-52`) declares `max_concurrent`,
`max_clip_watch_seconds`, `max_vod_watch_seconds`, `interval_seconds`
(plus `max_failures_per_streamer`, `failure_cooldown_seconds`, which do
match). Using the example's names raises `TypeError`. Use the dataclass
names, and add a `test_contract.py` assertion pinning them so an upstream
rename surfaces as a named failure.

Global defaults stay an adapter concept: `run.py` never passes
`streamer_settings=` to the constructor — `build_streamers` merges defaults
into each streamer instead. Keep it that way, so we never depend on
upstream's three-layer precedence.

## Decisions

Both settled 2026-09-10:

- **Inherit-with-resolved-preview** is the model for per-streamer fields,
  as described under "Inheritance model".
- **Miner-wide options live on the existing Settings page**, in their own
  section alongside the global defaults, rather than on a separate screen.
  Revisit if that page grows unwieldy.
