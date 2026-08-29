# Twitch Miner Control UI — Design

**Date:** 2026-08-29
**Status:** Approved for planning

## Problem

[Twitch-Channel-Points-Miner](https://github.com/rdavydov/Twitch-Channel-Points-Miner-v2)
is configured by hand-editing `run.py` and restarting the process. Changing the
watched streamer list means editing Python and restarting a Docker container.
There is no view of who is live, what has been collected, or whether the miner
is healthy.

This project builds a web application that owns the miner's configuration and
lifecycle, and presents a dashboard over its state.

## Upstream choice: mpforce1 fork

We build on
[mpforce1/Twitch-Channel-Points-Miner](https://github.com/mpforce1/Twitch-Channel-Points-Miner),
a direct fork of rdavydov's repo, rather than rdavydov's itself.

| | rdavydov | mpforce1 |
|---|---|---|
| Stars | 1,723 | 36 |
| Last push | 2026-07-16 | 2026-08-28 |
| Open issues | 197 | 15 |
| Divergence | — | 139 ahead, 12 behind |

Despite the star gap, mpforce1 is the better base:

- **Hermes WebSocket support.** Twitch is migrating off PubSub; mpforce1 has
  implemented the newer transport and exposes it as `use_hermes`. rdavydov's
  tree has none.
- Watch-streak recovery, weekly-rewards progression, `StreamerSelector`
  filter/sort strategies, `points_limit`, ongoing GQL hash updates.
- Modern packaging: `pyproject.toml`, `uv.lock`, `tests/`, pre-commit,
  `compose.yaml`.

**Risk:** a 36-star project is a real bus-factor concern. Mitigated by the
isolation rule below — if mpforce1 stalls, our integration surface is four
classes wide and can be re-pointed at another fork.

## Constraints (decided)

1. **No true hot-swap.** Streamer changes take effect via a managed process
   restart, not live re-subscription.
2. **Single container.** Node backend supervises the Python miner as a child
   process. No Docker socket, no elevated privileges.
3. **Config scope:** streamer list, per-streamer settings, and Twitch login.
   Credentials, notifications, and logger config stay hand-written.
4. **LAN only, single shared password.** Not designed to face the internet.
5. **No reliance on the miner's analytics server.** `enable_analytics` defaults
   to `False` upstream and materially increases memory use.
6. **No parsing of log messages for state.**

## Key findings from upstream source

These drove the design and should be re-verified if upstream is bumped.

**Streamer list is static.** `mine()` delegates to `run()`, which resolves the
list once at startup into `Streamer` objects. There is no runtime add/remove.
This is why constraint 1 exists.

**Event hooks carry no structured data.** Hooks dispatch from inside
`LoggerFormatter.format()` (`logger.py:228`), synchronously, only for records
with an `event` attribute. Every `extra={...}` in the codebase carries exactly
two keys: `emoji` and `event`. `EventHook.validate_and_send` forwards only
`record.msg` and `record.event`.

**Log messages are lossy.** `{streamer}` interpolates `Streamer.__repr__`
(`entities/Streamer.py:201`), which renders the balance through `millify()` —
a total arrives as `"12.3k"` — and routes the username through the anonymiser.
Messages are therefore unusable as a data source.

**The GQL layer is good.** Typed response classes, exact `balance: int`,
persisted-query hashes centralized in `constants.py`, and construction
decoupled from a running miner (`ClientSession(login, ...)` →
`GQLFactory.create(session)`).

**Shutdown is signal-driven.** `run()` installs handlers for SIGINT, SIGSEGV
and SIGTERM (`TwitchChannelPointsMiner.py:340`); `end()` disconnects IRC, joins
threads, closes websocket pools, and calls `sys.exit(0)`.

**Password login does not exist.** `login_flow_backup` is entirely inside a
docstring. `login_flow()` implements OAuth 2.0 device flow against
`https://id.twitch.tv/oauth2/device`, but only logs `user_code` before blocking
in a poll loop.

## Architecture

Five components in one container:

| Component | Language | Role |
|---|---|---|
| Web backend | Node/TS | HTTP API + SSE; owns `config.json` and SQLite; supervises the miner |
| Miner | Python | Unmodified upstream, launched via our `run.py` |
| Doorbell hook | Python (~30 lines) | `EventHook` subclass in `run.py`; POSTs `{event, ts}` |
| State/login helper | Python (~150 lines) | Imports `TwitchLogin` + `GQL`; NDJSON over stdio |
| Frontend | TS + Mantine | SPA served by the backend |

**Isolation rule: nothing we write lives inside the miner's source tree.** The
fork stays pristine and rebaseable. We depend on exactly four public seams:
`EventHook`, `TwitchLogin`, `ClientSession`, `GQL`.

### Data flow

The browser holds an SSE connection. The backend refreshes state from the
helper every 60s and immediately when the doorbell rings (debounced), diffs
against last known state, and pushes deltas. Config edits stage in memory;
"Apply & Restart" writes `config.json` and restarts the miner.

### Why the doorbell, not event parsing

The hook extracts nothing. It enqueues `(event_name, timestamp)` and returns
immediately — it must not block, because it runs inside the log formatter on
the miner's own threads. The backend treats a ring as "something changed,
refresh now" and re-reads the structured source.

Consequence: if upstream rewrites every log string, the doorbell stops ringing
and the dashboard falls back to its 60s poll. It never shows wrong data.

## Config model

`run.py` is a fixed, hand-written ~80-line adapter that reads `config.json` at
startup. The backend never generates Python.

```python
cfg = json.load(open("config.json"))
streamers = [Streamer(s["username"], StreamerSettings(**s["settings"]))
             for s in cfg["streamers"] if s["enabled"]]
```

Rationale: generating executable Python from web-form input is a code-injection
surface, and a template drifts whenever upstream adds a `StreamerSettings`
field. Credentials, notifications and logger config stay hand-written in
`run.py` as the user's escape hatch.

```json
{
  "version": 1,
  "followers": true,
  "followersOrder": "ASC",
  "defaults": { "make_predictions": false, "claim_drops": true },
  "streamers": [
    { "username": "xqc", "enabled": true,
      "settings": { "make_predictions": false, "points_limit": 50000 } }
  ]
}
```

Array order **is** priority — `mine()` takes an ordered list. Validation is a
Zod schema mirroring `StreamerSettings.__slots__`: usernames match
`^[a-zA-Z0-9_]{4,25}$`; all other fields are bool, int, or closed-set enum.
Writes are atomic (temp file + rename).

## Supervisor

States: `STOPPED`, `STARTING`, `RUNNING`, `LOGIN_REQUIRED`, `RESTARTING`,
`CRASHED`.

**Restart:** write config atomically → SIGTERM → wait 20s grace (thread joins
and IRC disconnect are not instant) → SIGKILL if alive → respawn. Restart
requests serialize behind a mutex so a double-click cannot fork two miners.

**Crash recovery:** exponential backoff 1s → 5min cap; after 5 consecutive
failures, park in `CRASHED` and require manual start. A miner hot-looping
against Twitch auth risks rate-limiting.

**Restarts are explicit.** Edits stage as pending changes committed by an
"Apply & Restart" action, so editing five streamers costs one restart and
downtime is always chosen.

Miner stdout/stderr is teed into a ~2000-line ring buffer for a live log panel.
**Display only — never parsed for state.**

## Login

The helper reimplements the ~40-line device flow using `TwitchLogin`'s own
`requests` session, emitting NDJSON on stdout:

```
{"stage":"code","user_code":"ABCD1234","verification_uri":"https://twitch.tv/activate","expires_at":"..."}
{"stage":"pending"}
{"stage":"ok","username":"alex"}
```

Reimplementation is justified here — and only here — because this is Twitch's
documented public OAuth endpoint, which does not churn like the GQL persisted-
query hashes. Everything stateful still goes through `TwitchLogin`: its session
accumulates the cookies `save_cookies()` needs, so the pickle format remains
upstream's concern.

Scopes are upstream's: `channel_read chat:read user_blocks_edit
user_blocks_read user_follows_edit user_read`.

**Session detection:** on backend startup, missing pickle or `check_login()`
returning false → `LOGIN_REQUIRED`. `check_login()` validates by fetching the
user ID over GraphQL, not merely checking the file exists.

## Read path

The state helper is a long-lived process speaking NDJSON over stdin/stdout —
one warm `ClientSession`, no per-query startup or re-login. Node sends
`{"op":"state","streamers":[...]}` and reads one JSON line back.

`GQL.post_gql_request_batch` batches N streamers into one round trip. Each
refresh yields exact `balance: int`, live status via `with_is_stream_live_query`,
and the follow list via `channel_follows` when `followers: true`.

Cadence: 60s full refresh, plus doorbell-triggered refresh debounced to coalesce
bursts (a raid fires several events at once).

**SQLite** holds `point_snapshots(streamer, ts, balance)`, written on change
only, and `events(ts, type, streamer_id?)` — event type only, never message
text. This gives points-over-time history that is ours and independent of the
miner's analytics.

## API surface

```
POST /api/session                  password → httpOnly session cookie
GET  /api/status                   supervisor state, login state, staleness
GET  /api/config
PUT  /api/config                   stage changes
POST /api/config/apply             write + restart
POST /api/miner/{start,stop,restart}
GET  /api/streamers
GET  /api/followers
GET  /api/history?streamer=&from=&to=
GET  /api/logs                     ring buffer
GET  /api/stream                   SSE
POST /api/twitch/login             start device flow; progress over SSE
GET  /api/streamers/lookup?q=      resolve via get_id_from_login before adding
```

`lookup` exists because a typo'd username is currently a silent no-op until
after a restart; we resolve against Twitch and reject in the form.

## Frontend

Mantine `AppShell` with four screens:

- **Dashboard** — who is live, current balances, points-over-time chart,
  activity feed
- **Streamers** — drag-to-reorder list (order is priority), enable toggles,
  per-streamer settings drawer
- **Logs** — virtualized view of the ring buffer
- **Settings** — followers options, session password, login status

A persistent bottom bar appears whenever changes are staged: *"3 pending
changes — Apply & Restart"*.

Visual design is deliberately out of scope for this spec and will be decided
during implementation.

## Error handling

Governing principle: **never show a confident number that might be wrong.**
Every state payload carries `lastUpdated`; the UI degrades to "stale, updated
4m ago" rather than presenting old balances as current.

| Failure | Behavior |
|---|---|
| Miner crashes | Backoff 1s→5min; after 5 tries → `CRASHED` + banner with last log lines |
| Miner exits <10s after start | Treated as unstartable config; park immediately, do not loop |
| Token expired | `check_login()` fails → stop miner, `LOGIN_REQUIRED`, show device code |
| Auth failure in helper | Reload cookies from disk once (miner may have refreshed the token) before reporting `LOGIN_REQUIRED` |
| State helper dies | Backend respawns; state marked stale meanwhile |
| GQL error / rate limit | Widen refresh interval, keep last state flagged stale |
| Invalid config | Rejected at the API with Zod errors; never written to disk |

## Testing

**Supervisor** is tested against a *fake miner* — a Python stub that traps
SIGTERM, optionally ignores it, or exits instantly. Covers graceful shutdown,
SIGKILL escalation, backoff, and the fast-exit park, with no Twitch account and
no network.

**Contract test against the real miner package** — imports `EventHook`,
`TwitchLogin`, `ClientSession`, `GQL` and asserts the symbols and method
signatures we depend on still exist. The entire design rests on those four
seams staying stable across a fork moving at 139 commits; this makes an
upstream bump fail loudly in CI rather than quietly at runtime.

**Python helpers** — pytest with mocked GQL responses.

**Frontend** — component tests on the stage/apply flow.

## Deployment

Multi-stage Dockerfile: Node build → Python runtime with `uv` → single image
running the backend as PID 1 (with `docker run --init`, so orphaned Python children are reaped), which spawns the miner and the state helper.
Volumes: `config.json`, the cookie pickle, SQLite, and `run.py`.

## Explicitly out of scope

- True hot-swap of streamers without restart (revisit only if restart downtime
  proves annoying; the API is shaped so the frontend would not change)
- Internet exposure, multi-user auth, TLS termination
- Editing bet strategies, notification integrations, or logger config
- Multiple Twitch accounts
- Any modification to the miner's own source tree
