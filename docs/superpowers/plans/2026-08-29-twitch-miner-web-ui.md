# Twitch Miner Control UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a LAN-only web app that owns the configuration and process lifecycle of the mpforce1 Twitch-Channel-Points-Miner, so streamers can be changed from a browser and miner state can be seen on a dashboard.

**Architecture:** A Fastify/TypeScript backend supervises the Python miner as a child process and owns `config.json`, which a fixed `run.py` adapter reads at startup. Two Python helper scripts import the miner's own `TwitchLogin` and `GQL` classes and speak NDJSON over stdio, giving the backend exact structured state without touching the miner's analytics server or parsing its logs. A Mantine SPA reads over HTTP and receives live deltas over SSE.

**Tech Stack:** Node 22, TypeScript 5.9, Fastify 5, Zod 4, better-sqlite3, Vitest, React 19, Vite 7, Mantine 8, Python 3.12, uv, pytest.

**Spec:** `docs/superpowers/specs/2026-08-29-twitch-miner-web-ui-design.md`

## Global Constraints

- **Miner upstream:** `mpforce1/Twitch-Channel-Points-Miner`, vendored as a git submodule at `vendor/miner`, pinned to an explicit commit. Never modify anything inside `vendor/miner`.
- **Integration seams:** only `EventHook`, `TwitchLogin`, `ClientSession`, `GQL` (plus `Streamer`, `StreamerSettings`, `ChatPresence` for config construction). Any new dependency on upstream internals requires updating the contract test.
- **Python:** 3.12+ (upstream `requires-python = ">=3.12"`). Managed with `uv`.
- **Never parse miner log messages for state.** `Streamer.__repr__` renders balances through `millify()` (`"12.3k"`) and routes usernames through the anonymiser. Logs are display-only.
- **Never generate Python source from user input.** The backend writes JSON only.
- **Working directory:** the miner resolves cookies as `./cookies/{username}.pkl` relative to CWD (`vendor/miner/TwitchChannelPointsMiner/classes/Twitch.py:92`). The backend MUST spawn the miner and both helpers with the same CWD (the app data directory).
- **The doorbell hook must never block.** It runs synchronously inside `LoggerFormatter.format()` on the miner's own threads.
- **Staleness is mandatory.** Every state payload carries `lastUpdated`; the UI must never present stale numbers as current.
- **Auth:** single shared password from the `APP_PASSWORD` env var, httpOnly session cookie. LAN only.
- **Test commands:** `pnpm test` (Node), `uv run pytest` (Python). Both must pass before every commit.

---

## File Structure

```
vendor/miner/                       git submodule, pinned, never modified
python/
  run.py                            fixed adapter: reads config.json, builds Streamers, installs hook
  helpers/doorbell.py               EventHook subclass; non-blocking POST
  helpers/state.py                  NDJSON stdio server over GQL reads
  helpers/login.py                  device-code OAuth, NDJSON progress
  helpers/_session.py               shared TwitchLogin/ClientSession/GQL bootstrap
  tests/                            pytest, incl. test_contract.py
apps/backend/src/
  config/schema.ts                  Zod schema mirroring StreamerSettings
  config/store.ts                   load/validate/atomic-write config.json
  miner/supervisor.ts               process state machine, signals, backoff
  miner/logBuffer.ts                ring buffer for stdout/stderr
  helpers/ndjsonClient.ts           long-lived helper process + request/response
  helpers/loginRunner.ts            one-shot login helper, emits progress events
  db/schema.ts                      SQLite tables + migrations
  db/history.ts                     snapshot + event writes/reads
  state/service.ts                  refresh loop, debounce, diffing, staleness
  http/server.ts                    Fastify app assembly
  http/auth.ts                      session password middleware
  http/routes.*.ts                  one file per route group
  http/sse.ts                       SSE broadcaster
apps/frontend/src/
  app.tsx, routes/, components/, api/
docker/Dockerfile, compose.yaml
```

Files that change together live together: each backend concern (config, miner, helpers, db, state, http) is its own directory with its own tests alongside.

---

## Task 1: Repository scaffolding and vendored miner

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitmodules`
- Create: `pyproject.toml`, `python/__init__.py`
- Create: `apps/backend/package.json`, `apps/backend/tsconfig.json`, `apps/backend/vitest.config.ts`
- Test: `apps/backend/src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: working `pnpm test` and `uv run pytest` commands; `vendor/miner` importable as `TwitchChannelPointsMiner`

- [ ] **Step 1: Add the miner as a pinned submodule**

```bash
git submodule add https://github.com/mpforce1/Twitch-Channel-Points-Miner.git vendor/miner
git -C vendor/miner rev-parse HEAD   # record this commit in the commit message
```

- [ ] **Step 2: Create the pnpm workspace**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"
```

`package.json`:
```json
{
  "name": "twitch-miner-ui",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  },
  "devDependencies": {
    "typescript": "^5.9.0"
  }
}
```

- [ ] **Step 3: Create the backend package**

`apps/backend/package.json`:
```json
{
  "name": "@app/backend",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "fastify": "^5.2.0",
    "@fastify/cookie": "^11.0.0",
    "better-sqlite3": "^11.7.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "@types/node": "^22.10.0",
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  }
}
```

`apps/backend/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`apps/backend/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
```

- [ ] **Step 4: Create the Python environment**

`pyproject.toml`:
```toml
[project]
name = "twitch-miner-ui-helpers"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["requests>=2.34.2"]

[dependency-groups]
dev = ["pytest>=8.3.0"]

[tool.pytest.ini_options]
testpaths = ["python/tests"]
pythonpath = [".", "vendor/miner"]
```

- [ ] **Step 5: Write a smoke test proving both toolchains run**

`apps/backend/src/smoke.test.ts`:
```ts
import { expect, test } from "vitest";

test("toolchain runs", () => {
  expect(1 + 1).toBe(2);
});
```

`python/tests/test_smoke.py`:
```python
def test_toolchain_runs():
    assert 1 + 1 == 2
```

- [ ] **Step 6: Run both test suites**

Run: `pnpm install && pnpm test`
Expected: PASS

Run: `uv sync && uv run pytest`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold workspace and vendor miner submodule"
```

---

## Task 2: Contract test against the miner package

This is the insurance policy for the whole design. It must exist before anything depends on those seams.

**Files:**
- Create: `python/tests/test_contract.py`

**Interfaces:**
- Consumes: `vendor/miner` on `sys.path` (Task 1)
- Produces: nothing consumed by later tasks; a CI gate that fails loudly on upstream drift

- [ ] **Step 1: Write the failing test**

`python/tests/test_contract.py`:
```python
"""Asserts the upstream miner API surface we depend on still exists.

If this fails after bumping vendor/miner, read
docs/superpowers/specs/2026-08-29-twitch-miner-web-ui-design.md
section "Key findings from upstream source" before changing anything.
"""
import inspect

from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from TwitchChannelPointsMiner.classes.ClientSession import ClientSession
from TwitchChannelPointsMiner.classes.EventHook import EventHook
from TwitchChannelPointsMiner.classes.Settings import Events
from TwitchChannelPointsMiner.classes.TwitchLogin import TwitchLogin
from TwitchChannelPointsMiner.classes.entities.Streamer import (
    Streamer,
    StreamerSettings,
)
from TwitchChannelPointsMiner.classes.gql.Integration import GQL, GQLFactory


def params(fn):
    return list(inspect.signature(fn).parameters)


def test_event_hook_surface():
    assert params(EventHook.send) == ["self", "message", "event"]
    assert params(EventHook.validate_record) == ["self", "record"]
    assert params(EventHook.validate_and_send) == ["self", "record"]


def test_events_we_rely_on_exist():
    for name in [
        "STREAMER_ONLINE",
        "STREAMER_OFFLINE",
        "GAIN_FOR_WATCH",
        "GAIN_FOR_CLAIM",
        "GAIN_FOR_RAID",
        "BONUS_CLAIM",
        "JOIN_RAID",
        "DROP_CLAIM",
    ]:
        assert Events.get(name) is not None, name


def test_twitch_login_surface():
    assert params(TwitchLogin.__init__) == [
        "self", "client_id", "device_id", "username", "user_agent", "password",
    ]
    assert params(TwitchLogin.save_cookies) == ["self", "cookies_file"]
    assert params(TwitchLogin.load_cookies) == ["self", "cookies_file"]
    assert params(TwitchLogin.check_login) == ["self"]
    assert params(TwitchLogin.set_token) == ["self", "new_token"]


def test_client_session_and_gql_construction():
    assert "login" in params(ClientSession.__init__)
    assert "user_agent" in params(ClientSession.__init__)
    assert params(GQLFactory.create) == ["self", "client_session"]
    for method in [
        "get_channel_points_context",
        "with_is_stream_live_query",
        "channel_follows",
        "get_id_from_login",
        "post_gql_request_batch",
    ]:
        assert callable(getattr(GQL, method)), method


def test_streamer_settings_fields_we_expose():
    exposed = {
        "make_predictions", "follow_raid", "claim_drops", "claim_moments",
        "watch_streak", "community_goals", "weekly_rewards", "points_limit",
        "chat",
    }
    assert exposed.issubset(set(StreamerSettings.__slots__))
    assert params(Streamer.__init__)[1] == "username"
    assert {"ALWAYS", "NEVER", "ONLINE", "OFFLINE"}.issubset(
        {m.name for m in ChatPresence}
    )
```

- [ ] **Step 2: Run it**

Run: `uv run pytest python/tests/test_contract.py -v`
Expected: PASS (it documents current reality; a failure here means the submodule pin is wrong)

- [ ] **Step 3: Verify it actually detects drift**

Temporarily edit the `test_event_hook_surface` assertion to expect a bogus parameter name, re-run, confirm FAIL, then revert.

Run: `uv run pytest python/tests/test_contract.py -v`
Expected: FAIL, then PASS after revert

- [ ] **Step 4: Commit**

```bash
git add python/tests/test_contract.py
git commit -m "test: pin upstream miner API contract"
```

---

## Task 3: Config-to-miner-objects mapping and `run.py` adapter

**Files:**
- Create: `python/miner_config.py`
- Create: `python/run.py`
- Test: `python/tests/test_miner_config.py`

**Interfaces:**
- Consumes: `Streamer`, `StreamerSettings`, `ChatPresence` (Task 2 contract)
- Produces: `build_streamers(cfg: dict) -> list[Streamer]`, `build_mine_kwargs(cfg: dict) -> dict` — the backend's `config.json` shape is defined by these functions and mirrored in Zod in Task 7

- [ ] **Step 1: Write the failing test**

`python/tests/test_miner_config.py`:
```python
import pytest

from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from miner_config import build_mine_kwargs, build_streamers

BASE = {
    "version": 1,
    "followers": True,
    "followersOrder": "ASC",
    "defaults": {"make_predictions": False, "claim_drops": True},
    "streamers": [],
}


def cfg(**over):
    return {**BASE, **over}


def test_disabled_streamers_are_excluded():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {}},
        {"username": "beta", "enabled": False, "settings": {}},
    ])
    assert [s.username for s in build_streamers(c)] == ["alpha"]


def test_order_is_preserved_because_order_is_priority():
    c = cfg(streamers=[
        {"username": "c", "enabled": True, "settings": {}},
        {"username": "a", "enabled": True, "settings": {}},
        {"username": "b", "enabled": True, "settings": {}},
    ])
    assert [s.username for s in build_streamers(c)] == ["c", "a", "b"]


def test_defaults_apply_and_per_streamer_settings_override():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True,
         "settings": {"make_predictions": True}},
    ])
    settings = build_streamers(c)[0].settings
    assert settings.make_predictions is True   # overridden
    assert settings.claim_drops is True        # from defaults


def test_chat_presence_string_maps_to_enum():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"chat": "NEVER"}},
    ])
    assert build_streamers(c)[0].settings.chat is ChatPresence.NEVER


def test_points_limit_false_is_preserved_not_coerced_to_zero():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True,
         "settings": {"points_limit": False}},
    ])
    assert build_streamers(c)[0].settings.points_limit is False


def test_unknown_setting_key_is_rejected():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"evil": 1}},
    ])
    with pytest.raises(ValueError, match="evil"):
        build_streamers(c)


def test_mine_kwargs_carry_follower_options():
    assert build_mine_kwargs(cfg()) == {"followers": True, "followers_order": "ASC"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest python/tests/test_miner_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'miner_config'`

- [ ] **Step 3: Write the implementation**

`python/miner_config.py`:
```python
"""Maps the backend-owned config.json onto miner objects.

Pure functions only, so they are testable without starting a miner.
The accepted shape here IS the contract; apps/backend/src/config/schema.ts
mirrors it in Zod.
"""
from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from TwitchChannelPointsMiner.classes.entities.Streamer import (
    Streamer,
    StreamerSettings,
)

BOOL_SETTINGS = (
    "make_predictions",
    "follow_raid",
    "claim_drops",
    "claim_moments",
    "watch_streak",
    "community_goals",
    "weekly_rewards",
)
ALLOWED_SETTINGS = frozenset(BOOL_SETTINGS + ("points_limit", "chat"))


def _settings(defaults: dict, overrides: dict) -> StreamerSettings:
    merged = {**defaults, **overrides}
    unknown = set(merged) - ALLOWED_SETTINGS
    if unknown:
        raise ValueError(f"unknown streamer settings: {sorted(unknown)}")
    if "chat" in merged and merged["chat"] is not None:
        merged["chat"] = ChatPresence[merged["chat"]]
    return StreamerSettings(**merged)


def build_streamers(cfg: dict) -> list[Streamer]:
    """Builds Streamer objects in config order. Order is priority."""
    defaults = cfg.get("defaults") or {}
    return [
        Streamer(s["username"], settings=_settings(defaults, s.get("settings") or {}))
        for s in cfg["streamers"]
        if s.get("enabled", True)
    ]


def build_mine_kwargs(cfg: dict) -> dict:
    return {
        "followers": bool(cfg.get("followers", False)),
        "followers_order": cfg.get("followersOrder", "ASC"),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest python/tests/test_miner_config.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Write `run.py`**

This file is the user's escape hatch. Credentials, notifications and logger config are hand-edited here and never touched by the backend.

`python/run.py`:
```python
# -*- coding: utf-8 -*-
"""Adapter entry point. Reads config.json; the web UI writes it.

Hand-edit the TwitchChannelPointsMiner(...) call below for credentials,
notifications and logger settings. The web UI only ever rewrites
config.json, never this file.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "vendor", "miner"))

from TwitchChannelPointsMiner import TwitchChannelPointsMiner
from TwitchChannelPointsMiner.classes.Settings import FollowersOrder, LoggerSettings

from helpers.doorbell import DoorbellHook
from miner_config import build_mine_kwargs, build_streamers

CONFIG_PATH = os.environ.get("MINER_CONFIG", "config.json")
DOORBELL_URL = os.environ.get("DOORBELL_URL", "http://127.0.0.1:8080/internal/doorbell")
DOORBELL_TOKEN = os.environ["DOORBELL_TOKEN"]

with open(CONFIG_PATH, encoding="utf-8") as fh:
    cfg = json.load(fh)

twitch_miner = TwitchChannelPointsMiner(
    username=cfg["username"],
    enable_analytics=False,
    use_hermes=True,
    logger_settings=LoggerSettings(
        save=True,
        console_level=20,
        hooks=[DoorbellHook(DOORBELL_URL, DOORBELL_TOKEN)],
    ),
)

kwargs = build_mine_kwargs(cfg)
twitch_miner.mine(
    streamers=build_streamers(cfg),
    followers=kwargs["followers"],
    followers_order=FollowersOrder[kwargs["followers_order"]],
)
```

- [ ] **Step 6: Verify `run.py` fails cleanly on a bad config rather than hanging**

```bash
cd python && echo '{"version":1,"streamers":[]}' > /tmp/bad.json
DOORBELL_TOKEN=x MINER_CONFIG=/tmp/bad.json uv run python run.py; echo "exit=$?"
```
Expected: exits non-zero within a few seconds with a `KeyError: 'username'` traceback. This fast-exit behavior is what Task 9's "unstartable config" detection relies on.

- [ ] **Step 7: Commit**

```bash
git add python/miner_config.py python/run.py python/tests/test_miner_config.py
git commit -m "feat: map config.json onto miner objects via run.py adapter"
```

---

## Task 4: Non-blocking doorbell hook

**Files:**
- Create: `python/helpers/doorbell.py`, `python/helpers/__init__.py`
- Test: `python/tests/test_doorbell.py`

**Interfaces:**
- Consumes: `EventHook`, `Events` (Task 2)
- Produces: `DoorbellHook(url: str, token: str, queue_size: int = 256)` with `.send(message, event)`, `.validate_record(record)`, `.pending()` and `.stop()` — used by `run.py` (Task 3) and received by the backend endpoint in Task 12

- [ ] **Step 1: Write the failing test**

`python/tests/test_doorbell.py`:
```python
import threading
import time

from TwitchChannelPointsMiner.classes.Settings import Events

from helpers.doorbell import DoorbellHook


def test_send_does_not_block_when_transport_is_slow():
    """The hook runs inside LoggerFormatter.format() on the miner's own
    threads. A slow POST must never stall the miner."""
    release = threading.Event()

    def slow_post(payload):
        release.wait(timeout=5)

    hook = DoorbellHook("http://unused", "tok", post=slow_post)
    started = time.monotonic()
    for _ in range(10):
        hook.send("anything", Events.STREAMER_ONLINE)
    elapsed = time.monotonic() - started
    release.set()
    hook.stop()
    assert elapsed < 0.1


def test_send_drops_rather_than_blocks_when_queue_is_full():
    release = threading.Event()
    hook = DoorbellHook(
        "http://unused", "tok", queue_size=2, post=lambda p: release.wait(timeout=5)
    )
    for _ in range(50):
        hook.send("anything", Events.STREAMER_ONLINE)
    release.set()
    hook.stop()
    assert hook.dropped > 0


def test_payload_carries_only_event_name_and_timestamp():
    """No message text: Streamer.__repr__ millifies balances, so the
    message is lossy and must never become a data source."""
    seen = []
    hook = DoorbellHook("http://unused", "tok", post=seen.append)
    hook.send("+50 -> Streamer(channel_points=12.3k)", Events.GAIN_FOR_CLAIM)
    hook.flush(timeout=2)
    hook.stop()
    assert len(seen) == 1
    assert set(seen[0]) == {"event", "ts"}
    assert seen[0]["event"] == "GAIN_FOR_CLAIM"


def test_records_without_event_attribute_are_ignored():
    hook = DoorbellHook("http://unused", "tok", post=lambda p: None)
    assert hook.validate_record(object()) is False
    hook.stop()


def test_transport_errors_do_not_escape():
    def boom(payload):
        raise RuntimeError("backend down")

    hook = DoorbellHook("http://unused", "tok", post=boom)
    hook.send("anything", Events.STREAMER_ONLINE)
    hook.flush(timeout=2)
    hook.stop()  # must not raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest python/tests/test_doorbell.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'helpers.doorbell'`

- [ ] **Step 3: Write the implementation**

`python/helpers/doorbell.py`:
```python
"""Doorbell: tells the backend that something happened, never what.

Upstream hooks are dispatched synchronously from inside
LoggerFormatter.format(), so send() must return immediately. The payload
deliberately carries no message text: log messages render balances through
millify() and are lossy.
"""
import logging
import queue
import threading
import time

import requests

from TwitchChannelPointsMiner.classes.EventHook import EventHook

logger = logging.getLogger(__name__)


class DoorbellHook(EventHook):
    def __init__(self, url, token, queue_size=256, post=None):
        self.url = url
        self.token = token
        self.dropped = 0
        self._queue = queue.Queue(maxsize=queue_size)
        self._post = post if post is not None else self._http_post
        self._stopping = threading.Event()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def _http_post(self, payload):
        requests.post(
            self.url,
            json=payload,
            headers={"X-Doorbell-Token": self.token},
            timeout=5,
        )

    def _run(self):
        while True:
            item = self._queue.get()
            try:
                if item is None:
                    return
                self._post(item)
            except Exception:
                logger.debug("doorbell delivery failed", exc_info=True)
            finally:
                self._queue.task_done()

    def validate_record(self, record) -> bool:
        return hasattr(record, "event")

    def send(self, message: str, event) -> None:
        try:
            self._queue.put_nowait({"event": str(event), "ts": time.time()})
        except queue.Full:
            self.dropped += 1

    def flush(self, timeout=5):
        deadline = time.monotonic() + timeout
        while not self._queue.empty() and time.monotonic() < deadline:
            time.sleep(0.01)

    def stop(self):
        if self._stopping.is_set():
            return
        self._stopping.set()
        self._queue.put(None)
        self._worker.join(timeout=2)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest python/tests/test_doorbell.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add python/helpers/ python/tests/test_doorbell.py
git commit -m "feat: add non-blocking doorbell event hook"
```

---

## Task 5: Shared Twitch session bootstrap

**Files:**
- Create: `python/helpers/_session.py`
- Test: `python/tests/test_session.py`

**Interfaces:**
- Consumes: `TwitchLogin`, `ClientSession`, `GQLFactory`, `CLIENT_ID`, `CLIENT_VERSION` (Task 2)
- Produces: `build_session(username: str, cookies_dir: str) -> Session` where `Session` has `.login: TwitchLogin`, `.gql: GQL`, `.cookies_file: str`, `.reload_cookies() -> bool`, `.is_logged_in() -> bool`

This mirrors `vendor/miner/TwitchChannelPointsMiner/classes/Twitch.py:84-123` exactly. If the contract test in Task 2 fails, re-read that constructor before changing this file.

- [ ] **Step 1: Write the failing test**

`python/tests/test_session.py`:
```python
import os
import pickle

import pytest

from helpers._session import build_session


def write_cookies(cookies_dir, username, token="tok"):
    os.makedirs(cookies_dir, exist_ok=True)
    path = os.path.join(cookies_dir, f"{username}.pkl")
    with open(path, "wb") as fh:
        pickle.dump([{"name": "auth-token", "value": token}], fh)
    return path


def test_cookies_file_follows_upstream_naming(tmp_path):
    session = build_session("alex", str(tmp_path))
    assert session.cookies_file == os.path.join(str(tmp_path), "alex.pkl")


def test_is_logged_in_false_when_no_cookie_file(tmp_path):
    session = build_session("alex", str(tmp_path))
    assert session.is_logged_in() is False


def test_is_logged_in_delegates_to_check_login(tmp_path, monkeypatch):
    write_cookies(str(tmp_path), "alex")
    session = build_session("alex", str(tmp_path))
    monkeypatch.setattr(session.login, "check_login", lambda: True)
    assert session.is_logged_in() is True


def test_reload_cookies_returns_false_when_file_missing(tmp_path):
    session = build_session("alex", str(tmp_path))
    assert session.reload_cookies() is False


def test_reload_cookies_reads_token_written_by_the_miner(tmp_path, monkeypatch):
    write_cookies(str(tmp_path), "alex", token="fresh")
    session = build_session("alex", str(tmp_path))
    monkeypatch.setattr(session.login, "get_auth_token", lambda: "fresh")
    seen = []
    monkeypatch.setattr(session.login, "set_token", seen.append)
    assert session.reload_cookies() is True
    assert seen == ["fresh"]


def test_gql_is_constructed(tmp_path):
    session = build_session("alex", str(tmp_path))
    assert hasattr(session.gql, "get_channel_points_context")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest python/tests/test_session.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'helpers._session'`

- [ ] **Step 3: Write the implementation**

`python/helpers/_session.py`:
```python
"""Builds a read-only Twitch session from the miner's own cookie pickle.

Mirrors Twitch.__init__ (vendor/miner/.../classes/Twitch.py:84-123). We never
write cookies here; only helpers/login.py does.
"""
import os
import string
from dataclasses import dataclass
from secrets import choice, token_hex

from TwitchChannelPointsMiner.classes.ClientSession import ClientSession
from TwitchChannelPointsMiner.classes.TwitchLogin import TwitchLogin
from TwitchChannelPointsMiner.classes.gql.Integration import GQL, GQLFactory
from TwitchChannelPointsMiner.constants import CLIENT_ID, CLIENT_VERSION, USER_AGENTS

USER_AGENT = USER_AGENTS["Linux"]["FIREFOX"]


@dataclass
class Session:
    login: TwitchLogin
    gql: GQL
    cookies_file: str

    def reload_cookies(self) -> bool:
        """Re-reads the pickle. The miner may have refreshed the token."""
        if not os.path.isfile(self.cookies_file):
            return False
        self.login.load_cookies(self.cookies_file)
        self.login.set_token(self.login.get_auth_token())
        return True

    def is_logged_in(self) -> bool:
        if not self.reload_cookies():
            return False
        return bool(self.login.check_login())


def build_session(username: str, cookies_dir: str) -> Session:
    device_id = "".join(choice(string.ascii_letters + string.digits) for _ in range(32))
    login = TwitchLogin(CLIENT_ID, device_id, username, USER_AGENT)
    client_session = ClientSession(
        login=login,
        user_agent=USER_AGENT,
        version=CLIENT_VERSION,
        device_id=device_id,
        session_id=token_hex(16),
        version_outdated=True,
    )
    return Session(
        login=login,
        gql=GQLFactory().create(client_session),
        cookies_file=os.path.join(cookies_dir, f"{username}.pkl"),
    )
```

- [ ] **Step 4: Confirm the USER_AGENTS key path is real**

Run: `uv run python -c "from TwitchChannelPointsMiner.constants import USER_AGENTS; print(list(USER_AGENTS), list(USER_AGENTS['Linux']))"`
Expected: prints available platform and browser keys. If `Linux`/`FIREFOX` are absent, pick an existing pair and update both `_session.py` and this step.

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest python/tests/test_session.py -v`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add python/helpers/_session.py python/tests/test_session.py
git commit -m "feat: add shared Twitch session bootstrap for helpers"
```

---

## Task 6: State helper (NDJSON stdio server)

**Files:**
- Create: `python/helpers/state.py`
- Test: `python/tests/test_state.py`

**Interfaces:**
- Consumes: `build_session` (Task 5)
- Produces: an NDJSON request/response protocol on stdin/stdout. Requests: `{"id":N,"op":"ping"}`, `{"id":N,"op":"check_login"}`, `{"id":N,"op":"lookup","username":"x"}`, `{"id":N,"op":"state","streamers":["a","b"]}`, `{"id":N,"op":"followers"}`. Responses: `{"id":N,"ok":true,"data":...}` or `{"id":N,"ok":false,"error":"...","code":"AUTH"|"GQL"|"BAD_REQUEST"}`. Consumed by `ndjsonClient.ts` (Task 8).

- [ ] **Step 1: Write the failing test**

`python/tests/test_state.py`:
```python
import io
import json
from types import SimpleNamespace

import pytest

from helpers.state import Handler, serve


def points_response(balance, channel_id="42", enabled=True):
    return SimpleNamespace(
        community=SimpleNamespace(
            display_name="Alpha",
            channel=SimpleNamespace(
                id=channel_id,
                edge=SimpleNamespace(
                    community_points=SimpleNamespace(balance=balance)
                ),
                community_points_settings=SimpleNamespace(is_enabled=enabled),
            ),
        )
    )


class FakeGQL:
    def __init__(self, balances=None, live=None, follows=None):
        self.balances = balances or {}
        self.live = live or {}
        self.follows = follows or []

    def get_channel_points_context(self, username):
        if username not in self.balances:
            return SimpleNamespace(community=None)
        return points_response(self.balances[username])

    def with_is_stream_live_query(self, channel_id):
        stream = SimpleNamespace(id="s1") if self.live.get(channel_id) else None
        return SimpleNamespace(user=SimpleNamespace(id=channel_id, stream=stream))

    def get_id_from_login(self, username):
        return SimpleNamespace(id="42" if username == "alpha" else "")

    def channel_follows(self, limit=100, order=None):
        return self.follows


def handler(**kw):
    session = SimpleNamespace(
        gql=FakeGQL(**kw), reload_cookies=lambda: True, is_logged_in=lambda: True
    )
    return Handler(session)


def test_state_returns_exact_integer_balance():
    h = handler(balances={"alpha": 123456}, live={"42": True})
    out = h.handle({"id": 1, "op": "state", "streamers": ["alpha"]})
    assert out["ok"] is True
    assert out["data"]["streamers"][0] == {
        "username": "alpha",
        "channelId": "42",
        "displayName": "Alpha",
        "points": 123456,
        "isOnline": True,
        "pointsEnabled": True,
    }


def test_offline_streamer_reported_as_not_online():
    h = handler(balances={"alpha": 10}, live={"42": False})
    out = h.handle({"id": 1, "op": "state", "streamers": ["alpha"]})
    assert out["data"]["streamers"][0]["isOnline"] is False


def test_unknown_streamer_yields_null_points_not_zero():
    """Zero would be indistinguishable from a real empty balance."""
    h = handler(balances={})
    out = h.handle({"id": 1, "op": "state", "streamers": ["ghost"]})
    assert out["data"]["streamers"][0]["points"] is None


def test_one_failing_streamer_does_not_fail_the_whole_batch():
    class Exploding(FakeGQL):
        def get_channel_points_context(self, username):
            if username == "bad":
                raise RuntimeError("gql exploded")
            return super().get_channel_points_context(username)

    session = SimpleNamespace(
        gql=Exploding(balances={"alpha": 5}, live={"42": True}),
        reload_cookies=lambda: True,
        is_logged_in=lambda: True,
    )
    out = Handler(session).handle(
        {"id": 1, "op": "state", "streamers": ["alpha", "bad"]}
    )
    assert out["ok"] is True
    names = {s["username"]: s for s in out["data"]["streamers"]}
    assert names["alpha"]["points"] == 5
    assert names["bad"]["error"] == "gql exploded"


def test_lookup_resolves_a_real_username():
    h = handler()
    assert h.handle({"id": 1, "op": "lookup", "username": "alpha"})["data"] == {
        "username": "alpha",
        "channelId": "42",
        "exists": True,
    }


def test_lookup_reports_missing_username():
    h = handler()
    assert h.handle({"id": 1, "op": "lookup", "username": "nope"})["data"]["exists"] is False


def test_followers_returns_logins():
    h = handler(follows=["a", "b"])
    assert h.handle({"id": 1, "op": "followers"})["data"] == {"followers": ["a", "b"]}


def test_unknown_op_is_a_bad_request():
    out = handler().handle({"id": 7, "op": "nonsense"})
    assert out == {"id": 7, "ok": False, "error": "unknown op: nonsense",
                   "code": "BAD_REQUEST"}


def test_auth_failure_triggers_one_cookie_reload_then_reports_auth():
    reloads = []

    class AuthFail(FakeGQL):
        def get_channel_points_context(self, username):
            raise RuntimeError("401 Unauthorized")

    session = SimpleNamespace(
        gql=AuthFail(),
        reload_cookies=lambda: (reloads.append(1), True)[1],
        is_logged_in=lambda: False,
    )
    out = Handler(session).handle({"id": 1, "op": "state", "streamers": ["alpha"]})
    assert out["ok"] is False
    assert out["code"] == "AUTH"
    assert len(reloads) == 1


def test_serve_reads_and_writes_one_line_per_request():
    stdin = io.StringIO('{"id":1,"op":"ping"}\n{"id":2,"op":"ping"}\n')
    stdout = io.StringIO()
    serve(handler(), stdin, stdout)
    lines = [json.loads(x) for x in stdout.getvalue().strip().split("\n")]
    assert [l["id"] for l in lines] == [1, 2]
    assert all(l["ok"] for l in lines)


def test_serve_survives_a_malformed_line():
    stdin = io.StringIO('not json\n{"id":2,"op":"ping"}\n')
    stdout = io.StringIO()
    serve(handler(), stdin, stdout)
    lines = [json.loads(x) for x in stdout.getvalue().strip().split("\n")]
    assert lines[0]["ok"] is False
    assert lines[1]["id"] == 2
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest python/tests/test_state.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'helpers.state'`

- [ ] **Step 3: Write the implementation**

`python/helpers/state.py`:
```python
"""Long-lived NDJSON server exposing structured miner state.

One request per stdin line, one response per stdout line. Reads go through
the miner's own GQL layer so persisted-query hashes stay upstream's problem.
"""
import json
import os
import sys

AUTH_MARKERS = ("401", "unauthorized", "authentication")


def _is_auth_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in AUTH_MARKERS)


class Handler:
    def __init__(self, session):
        self.session = session

    def handle(self, req: dict) -> dict:
        req_id = req.get("id")
        op = req.get("op")
        try:
            if op == "ping":
                return {"id": req_id, "ok": True, "data": {"pong": True}}
            if op == "check_login":
                return {"id": req_id, "ok": True,
                        "data": {"loggedIn": self.session.is_logged_in()}}
            if op == "lookup":
                return {"id": req_id, "ok": True, "data": self._lookup(req["username"])}
            if op == "followers":
                return {"id": req_id, "ok": True,
                        "data": {"followers": self.session.gql.channel_follows()}}
            if op == "state":
                return {"id": req_id, "ok": True,
                        "data": {"streamers": self._state(req["streamers"])}}
            return {"id": req_id, "ok": False, "error": f"unknown op: {op}",
                    "code": "BAD_REQUEST"}
        except KeyError as exc:
            return {"id": req_id, "ok": False, "error": f"missing field: {exc}",
                    "code": "BAD_REQUEST"}
        except Exception as exc:
            if _is_auth_error(exc):
                self.session.reload_cookies()
                if not self.session.is_logged_in():
                    return {"id": req_id, "ok": False, "error": str(exc),
                            "code": "AUTH"}
            return {"id": req_id, "ok": False, "error": str(exc), "code": "GQL"}

    def _lookup(self, username: str) -> dict:
        response = self.session.gql.get_id_from_login(username)
        channel_id = getattr(response, "id", "") or ""
        return {"username": username, "channelId": channel_id,
                "exists": bool(channel_id)}

    def _state(self, usernames: list[str]) -> list[dict]:
        out = []
        auth_error = None
        for username in usernames:
            try:
                out.append(self._one(username))
            except Exception as exc:
                if _is_auth_error(exc):
                    auth_error = exc
                    break
                out.append({"username": username, "points": None, "isOnline": None,
                            "error": str(exc)})
        if auth_error is not None:
            raise auth_error
        return out

    def _one(self, username: str) -> dict:
        context = self.session.gql.get_channel_points_context(username)
        community = getattr(context, "community", None)
        if community is None:
            return {"username": username, "channelId": None, "displayName": None,
                    "points": None, "isOnline": None, "pointsEnabled": None}
        channel = community.channel
        live = self.session.gql.with_is_stream_live_query(channel.id)
        return {
            "username": username,
            "channelId": channel.id,
            "displayName": community.display_name,
            "points": channel.edge.community_points.balance,
            "isOnline": live.user.stream is not None,
            "pointsEnabled": channel.community_points_settings.is_enabled,
        }


def serve(handler: Handler, stdin=sys.stdin, stdout=sys.stdout) -> None:
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            response = {"id": None, "ok": False, "error": f"bad json: {exc}",
                        "code": "BAD_REQUEST"}
        else:
            response = handler.handle(req)
        stdout.write(json.dumps(response) + "\n")
        stdout.flush()


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    # `python/` for the helpers package, `vendor/miner` for the miner package.
    sys.path.insert(0, os.path.join(here, ".."))
    sys.path.insert(0, os.path.join(here, "..", "..", "vendor", "miner"))
    from helpers._session import build_session

    session = build_session(os.environ["TWITCH_USERNAME"],
                            os.environ.get("COOKIES_DIR", "cookies"))
    serve(Handler(session))


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest python/tests/test_state.py -v`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add python/helpers/state.py python/tests/test_state.py
git commit -m "feat: add NDJSON state helper over the miner's GQL layer"
```

---

## Task 7: Login helper (device-code OAuth, NDJSON progress)

Reimplements the ~40-line device flow because upstream's `login_flow()` only *logs* the user code and then blocks. We reuse `TwitchLogin` for everything stateful, so the pickle format stays upstream's concern.

Note: upstream's expiry check is `if now == expires_at` — comparing two values fixed before the loop, so it never fires and an expired code polls forever. This implementation compares against the current time.

**Files:**
- Create: `python/helpers/login.py`
- Test: `python/tests/test_login.py`

**Interfaces:**
- Consumes: `build_session` (Task 5)
- Produces: NDJSON on stdout — `{"stage":"code","userCode":...,"verificationUri":...,"expiresAt":...}`, `{"stage":"pending"}`, `{"stage":"ok","username":...}`, `{"stage":"error","error":...}`. Consumed by `loginRunner.ts` (Task 9).

- [ ] **Step 1: Write the failing test**

`python/tests/test_login.py`:
```python
import io
import json
from types import SimpleNamespace

from helpers.login import device_login

SCOPES = (
    "channel_read chat:read user_blocks_edit "
    "user_blocks_read user_follows_edit user_read"
)


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FakeLogin:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.token = None
        self.saved_to = None
        self.username = "alex"

    def send_oauth_request(self, url, data):
        self.requests.append((url, data))
        return self.responses.pop(0)

    def set_token(self, token):
        self.token = token

    def check_login(self):
        return True

    def save_cookies(self, path):
        self.saved_to = path


def run(responses, **kw):
    login = FakeLogin(responses)
    session = SimpleNamespace(login=login, cookies_file="/tmp/alex.pkl")
    out = io.StringIO()
    device_login(session, out=out, sleep=lambda _s: None, now=iter_now(), **kw)
    lines = [json.loads(x) for x in out.getvalue().strip().split("\n")]
    return login, lines


def iter_now(start=0.0):
    counter = {"t": start}

    def _now():
        counter["t"] += 1.0
        return counter["t"]

    return _now


DEVICE_OK = FakeResponse(200, {
    "device_code": "dev", "user_code": "ABCD1234", "interval": 1,
    "expires_in": 1800, "verification_uri": "https://www.twitch.tv/activate",
})


def test_emits_code_then_ok():
    login, lines = run([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    assert lines[0]["stage"] == "code"
    assert lines[0]["userCode"] == "ABCD1234"
    assert lines[0]["verificationUri"] == "https://www.twitch.tv/activate"
    assert lines[-1] == {"stage": "ok", "username": "alex"}


def test_requests_upstreams_scopes():
    login, _ = run([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    assert login.requests[0][1]["scopes"] == SCOPES


def test_pending_is_emitted_while_user_has_not_entered_the_code():
    login, lines = run([
        DEVICE_OK,
        FakeResponse(400, {"message": "authorization_pending"}),
        FakeResponse(200, {"access_token": "tok"}),
    ])
    stages = [l["stage"] for l in lines]
    assert stages == ["code", "pending", "ok"]


def test_token_is_set_and_cookies_saved_on_success():
    login, _ = run([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    assert login.token == "tok"
    assert login.saved_to == "/tmp/alex.pkl"


def test_expired_code_stops_polling_instead_of_looping_forever():
    expiring = FakeResponse(200, {
        "device_code": "dev", "user_code": "ABCD1234", "interval": 1,
        "expires_in": 2, "verification_uri": "https://www.twitch.tv/activate",
    })
    pending = [FakeResponse(400, {}) for _ in range(20)]
    login, lines = run([expiring, *pending])
    assert lines[-1]["stage"] == "error"
    assert "expired" in lines[-1]["error"]


def test_device_request_failure_reports_error():
    login, lines = run([FakeResponse(500, {})])
    assert lines[-1]["stage"] == "error"


def test_failed_check_login_is_reported_as_error():
    class BadCheck(FakeLogin):
        def check_login(self):
            return False

    login = BadCheck([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    session = SimpleNamespace(login=login, cookies_file="/tmp/alex.pkl")
    out = io.StringIO()
    device_login(session, out=out, sleep=lambda _s: None, now=iter_now())
    lines = [json.loads(x) for x in out.getvalue().strip().split("\n")]
    assert lines[-1]["stage"] == "error"
    assert login.saved_to is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest python/tests/test_login.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'helpers.login'`

- [ ] **Step 3: Write the implementation**

`python/helpers/login.py`:
```python
"""OAuth 2.0 device-code login, emitting NDJSON progress.

Upstream's login_flow() only logs the user code before blocking, so it cannot
drive a UI. This is a reimplementation of the same public, documented flow
(https://id.twitch.tv/oauth2/device). Everything stateful still goes through
TwitchLogin so the cookie pickle format stays upstream's concern.
"""
import json
import os
import sys
import time

DEVICE_URL = "https://id.twitch.tv/oauth2/device"
TOKEN_URL = "https://id.twitch.tv/oauth2/token"
SCOPES = (
    "channel_read chat:read user_blocks_edit "
    "user_blocks_read user_follows_edit user_read"
)


def _emit(out, payload):
    out.write(json.dumps(payload) + "\n")
    out.flush()


def device_login(session, out=sys.stdout, sleep=time.sleep, now=time.monotonic):
    login = session.login
    response = login.send_oauth_request(
        DEVICE_URL, {"client_id": login.client_id, "scopes": SCOPES}
    )
    if response.status_code != 200:
        _emit(out, {"stage": "error",
                    "error": f"device request failed: HTTP {response.status_code}"})
        return False

    body = response.json()
    interval = body.get("interval", 5)
    deadline = now() + body.get("expires_in", 1800)
    _emit(out, {
        "stage": "code",
        "userCode": body["user_code"],
        "verificationUri": body.get("verification_uri",
                                    "https://www.twitch.tv/activate"),
        "expiresAt": deadline,
    })

    poll = {
        "client_id": login.client_id,
        "device_code": body["device_code"],
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    }
    while True:
        sleep(interval)
        if now() >= deadline:
            _emit(out, {"stage": "error", "error": "code expired, start again"})
            return False
        token_response = login.send_oauth_request(TOKEN_URL, poll)
        if token_response.status_code != 200:
            _emit(out, {"stage": "pending"})
            continue
        token = token_response.json().get("access_token")
        if not token:
            _emit(out, {"stage": "error", "error": "no access_token in response"})
            return False
        login.set_token(token)
        if not login.check_login():
            _emit(out, {"stage": "error", "error": "token rejected by Twitch"})
            return False
        login.save_cookies(session.cookies_file)
        _emit(out, {"stage": "ok", "username": login.username})
        return True


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    # `python/` for the helpers package, `vendor/miner` for the miner package.
    sys.path.insert(0, os.path.join(here, ".."))
    sys.path.insert(0, os.path.join(here, "..", "..", "vendor", "miner"))
    from helpers._session import build_session

    session = build_session(os.environ["TWITCH_USERNAME"],
                            os.environ.get("COOKIES_DIR", "cookies"))
    os.makedirs(os.path.dirname(session.cookies_file), exist_ok=True)
    sys.exit(0 if device_login(session) else 1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest python/tests/test_login.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Run the whole Python suite**

Run: `uv run pytest -v`
Expected: PASS (all tasks 2-7)

- [ ] **Step 6: Commit**

```bash
git add python/helpers/login.py python/tests/test_login.py
git commit -m "feat: add device-code login helper with NDJSON progress"
```

---

## Task 8: Config schema and atomic store

**Files:**
- Create: `apps/backend/src/config/schema.ts`, `apps/backend/src/config/store.ts`
- Test: `apps/backend/src/config/store.test.ts`

**Interfaces:**
- Consumes: the shape accepted by `miner_config.build_streamers` (Task 3)
- Produces: `AppConfig` type, `configSchema`, `loadConfig(path): AppConfig`, `saveConfig(path, cfg): void`, `DEFAULT_CONFIG`

- [ ] **Step 1: Write the failing test**

`apps/backend/src/config/store.test.ts`:
```ts
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { configSchema } from "./schema.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./store.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
  path = join(dir, "config.json");
});

const valid = {
  version: 1,
  username: "alex",
  followers: true,
  followersOrder: "ASC",
  defaults: { makePredictions: false },
  streamers: [{ username: "alpha", enabled: true, settings: {} }],
};

describe("schema", () => {
  test("accepts a valid config", () => {
    expect(configSchema.safeParse(valid).success).toBe(true);
  });

  test("rejects a username that cannot be a Twitch login", () => {
    const bad = { ...valid, streamers: [{ username: "a b!", enabled: true, settings: {} }] };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects unknown settings keys so they cannot reach Python", () => {
    const bad = { ...valid, streamers: [{ username: "alpha", enabled: true, settings: { evil: 1 } }] };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects duplicate streamers", () => {
    const bad = {
      ...valid,
      streamers: [
        { username: "alpha", enabled: true, settings: {} },
        { username: "alpha", enabled: false, settings: {} },
      ],
    };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  test("accepts points_limit as false or a positive integer, rejects negatives", () => {
    const mk = (v: unknown) => ({
      ...valid,
      streamers: [{ username: "alpha", enabled: true, settings: { pointsLimit: v } }],
    });
    expect(configSchema.safeParse(mk(false)).success).toBe(true);
    expect(configSchema.safeParse(mk(50000)).success).toBe(true);
    expect(configSchema.safeParse(mk(-1)).success).toBe(false);
  });

  test("accepts only real ChatPresence values", () => {
    const mk = (v: string) => ({
      ...valid,
      streamers: [{ username: "alpha", enabled: true, settings: { chat: v } }],
    });
    expect(configSchema.safeParse(mk("NEVER")).success).toBe(true);
    expect(configSchema.safeParse(mk("SOMETIMES")).success).toBe(false);
  });
});

describe("store", () => {
  test("returns defaults when the file does not exist", () => {
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG);
  });

  test("round-trips a saved config", () => {
    saveConfig(path, valid);
    expect(loadConfig(path)).toEqual(valid);
  });

  test("writes snake_case keys that Python accepts", () => {
    saveConfig(path, valid);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.defaults).toEqual({ make_predictions: false });
    expect(raw.followersOrder).toBe("ASC");
  });

  test("refuses to save an invalid config", () => {
    expect(() => saveConfig(path, { ...valid, version: 2 } as never)).toThrow();
  });

  test("throws a clear error on a corrupt file rather than returning defaults", () => {
    writeFileSync(path, "{not json");
    expect(() => loadConfig(path)).toThrow(/config.json/);
  });

  test("leaves no temp files behind after a save", () => {
    saveConfig(path, valid);
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/backend test`
Expected: FAIL — cannot resolve `./schema.js`

- [ ] **Step 3: Write the schema**

The UI uses camelCase; Python expects the snake_case names in `StreamerSettings.__slots__`. The boundary is here.

`apps/backend/src/config/schema.ts`:
```ts
import { z } from "zod";

/** Mirrors miner_config.ALLOWED_SETTINGS. Keep both in sync. */
export const BOOL_SETTINGS = [
  "makePredictions", "followRaid", "claimDrops", "claimMoments",
  "watchStreak", "communityGoals", "weeklyRewards",
] as const;

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
};

const settingsSchema = z
  .object({
    ...Object.fromEntries(BOOL_SETTINGS.map((k) => [k, z.boolean().optional()])),
    pointsLimit: z.union([z.literal(false), z.number().int().positive()]).optional(),
    chat: z.enum(["ALWAYS", "NEVER", "ONLINE", "OFFLINE"]).optional(),
  })
  .strict();

/** Twitch login rules: 4-25 chars, letters/digits/underscore. */
export const usernameSchema = z.string().regex(/^[a-zA-Z0-9_]{4,25}$/);

export const configSchema = z
  .object({
    version: z.literal(1),
    username: usernameSchema,
    followers: z.boolean(),
    followersOrder: z.enum(["ASC", "DESC"]),
    defaults: settingsSchema,
    streamers: z
      .array(
        z.object({
          username: usernameSchema,
          enabled: z.boolean(),
          settings: settingsSchema,
        }).strict(),
      )
      .refine(
        (list) => new Set(list.map((s) => s.username.toLowerCase())).size === list.length,
        { message: "duplicate streamer" },
      ),
  })
  .strict();

export type AppConfig = z.infer<typeof configSchema>;
export type StreamerSettingsInput = z.infer<typeof settingsSchema>;

export function settingsToPython(settings: StreamerSettingsInput) {
  return Object.fromEntries(
    Object.entries(settings).map(([k, v]) => [TO_PYTHON[k] ?? k, v]),
  );
}

export function settingsFromPython(raw: Record<string, unknown>) {
  const back = Object.fromEntries(Object.entries(TO_PYTHON).map(([a, b]) => [b, a]));
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [back[k] ?? k, v]),
  );
}
```

- [ ] **Step 4: Write the store**

`apps/backend/src/config/store.ts`:
```ts
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
  type AppConfig, configSchema, settingsFromPython, settingsToPython,
} from "./schema.js";

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  username: "",
  followers: false,
  followersOrder: "ASC",
  defaults: {},
  streamers: [],
};

export function loadConfig(path: string): AppConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`config.json is not valid JSON: ${String(cause)}`);
  }
  const r = raw as Record<string, never>;
  const camel = {
    ...r,
    defaults: settingsFromPython(r.defaults ?? {}),
    streamers: (r.streamers ?? []).map((s: Record<string, never>) => ({
      ...s,
      settings: settingsFromPython(s.settings ?? {}),
    })),
  };
  const parsed = configSchema.safeParse(camel);
  if (!parsed.success) {
    throw new Error(`config.json failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function saveConfig(path: string, config: AppConfig): void {
  const valid = configSchema.parse(config);
  const onDisk = {
    ...valid,
    defaults: settingsToPython(valid.defaults),
    streamers: valid.streamers.map((s) => ({
      ...s,
      settings: settingsToPython(s.settings),
    })),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (cause) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw cause;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @app/backend test`
Expected: PASS (12 tests)

- [ ] **Step 6: Cross-check the two schemas agree**

Add `python/tests/test_schema_parity.py`:
```python
"""The Zod schema and miner_config must expose the same settings keys."""
import json
import pathlib
import re

from miner_config import ALLOWED_SETTINGS


def test_zod_schema_maps_exactly_our_allowed_settings():
    source = pathlib.Path("apps/backend/src/config/schema.ts").read_text()
    block = re.search(r"TO_PYTHON: Record<string, string> = \{(.*?)\}", source, re.S)
    assert block, "TO_PYTHON map not found"
    python_names = set(re.findall(r':\s*"([a-z_]+)"', block.group(1)))
    assert python_names == set(ALLOWED_SETTINGS)
```

Run: `uv run pytest python/tests/test_schema_parity.py -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/config python/tests/test_schema_parity.py
git commit -m "feat: add validated config schema with atomic writes"
```

---

## Task 9: NDJSON helper client

**Files:**
- Create: `apps/backend/src/helpers/ndjsonClient.ts`
- Test: `apps/backend/src/helpers/ndjsonClient.test.ts`
- Create: `apps/backend/test/fixtures/echo-helper.mjs`

**Interfaces:**
- Consumes: the protocol from Task 6
- Produces: `class NdjsonClient { constructor(opts: {command: string; args: string[]; cwd: string; env: Record<string,string>; requestTimeoutMs?: number}); request<T>(op: string, params?: object): Promise<T>; stop(): Promise<void>; on("respawn", fn): void }`

- [ ] **Step 1: Write the test fixture**

`apps/backend/test/fixtures/echo-helper.mjs`:
```js
// Minimal stand-in for python/helpers/state.py speaking the same protocol.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.op === "crash") process.exit(3);
  if (req.op === "silent") return;
  process.stdout.write(
    `${JSON.stringify({ id: req.id, ok: true, data: { echoed: req.op } })}\n`,
  );
});
```

- [ ] **Step 2: Write the failing test**

`apps/backend/src/helpers/ndjsonClient.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { NdjsonClient } from "./ndjsonClient.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../../test/fixtures/echo-helper.mjs");

let client: NdjsonClient;
afterEach(async () => { await client?.stop(); });

function make(overrides = {}) {
  client = new NdjsonClient({
    command: process.execPath, args: [fixture], cwd: process.cwd(), env: {},
    ...overrides,
  });
  return client;
}

test("round-trips a request", async () => {
  await expect(make().request("ping")).resolves.toEqual({ echoed: "ping" });
});

test("matches concurrent responses to the right request", async () => {
  const c = make();
  const [a, b] = await Promise.all([c.request("one"), c.request("two")]);
  expect([a, b]).toEqual([{ echoed: "one" }, { echoed: "two" }]);
});

test("rejects when the helper never answers", async () => {
  await expect(make({ requestTimeoutMs: 100 }).request("silent")).rejects.toThrow(
    /timed out/,
  );
});

test("respawns after the helper dies and serves the next request", async () => {
  const c = make();
  const respawns: number[] = [];
  c.on("respawn", () => respawns.push(1));
  await expect(c.request("crash")).rejects.toThrow();
  await expect(c.request("ping")).resolves.toEqual({ echoed: "ping" });
  expect(respawns.length).toBe(1);
});

test("in-flight requests reject when the process exits", async () => {
  const c = make();
  const pending = c.request("silent");
  await c.request("crash").catch(() => {});
  await expect(pending).rejects.toThrow();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @app/backend test ndjsonClient`
Expected: FAIL — cannot resolve `./ndjsonClient.js`

- [ ] **Step 4: Write the implementation**

`apps/backend/src/helpers/ndjsonClient.ts`:
```ts
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";

export interface NdjsonClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class NdjsonClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private reader: Interface | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stopped = false;
  private readonly timeoutMs: number;

  constructor(private readonly options: NdjsonClientOptions) {
    super();
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private ensure(): ChildProcess {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.reader = createInterface({ input: child.stdout! });
    this.reader.on("line", (line) => this.onLine(line));
    child.on("exit", (code) => this.onExit(code));
    this.child = child;
    return child;
  }

  private onLine(line: string): void {
    let message: { id?: number; ok?: boolean; data?: unknown; error?: string };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.data);
    else entry.reject(new Error(message.error ?? "helper error"));
  }

  private onExit(code: number | null): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`helper exited with code ${code}`));
      this.pending.delete(id);
    }
    this.child = null;
    this.reader?.close();
    this.reader = null;
    if (!this.stopped) this.emit("respawn");
  }

  async request<T>(op: string, params: object = {}): Promise<T> {
    const child = this.ensure();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper request "${op}" timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void, reject, timer,
      });
      child.stdin!.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return;
    child.stdin?.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @app/backend test ndjsonClient`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/helpers apps/backend/test/fixtures
git commit -m "feat: add NDJSON helper client with respawn"
```

---

## Task 10: Miner supervisor

**Files:**
- Create: `apps/backend/src/miner/logBuffer.ts`, `apps/backend/src/miner/supervisor.ts`
- Test: `apps/backend/src/miner/logBuffer.test.ts`, `apps/backend/src/miner/supervisor.test.ts`
- Create: `apps/backend/test/fixtures/fake-miner.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `class LogBuffer { push(line: string): void; lines(): string[] }` and `class Supervisor { readonly state: MinerState; start(): Promise<void>; stop(): Promise<void>; restart(): Promise<void>; logs(): string[]; on("state", (s: MinerState) => void) }` where `type MinerState = "STOPPED" | "STARTING" | "RUNNING" | "RESTARTING" | "CRASHED"`

- [ ] **Step 1: Write the fake miner fixture**

`apps/backend/test/fixtures/fake-miner.mjs`:
```js
// Stands in for the Python miner. Behaviour via env:
//   FAKE_MODE=normal   run until SIGTERM, exit 0 cleanly
//   FAKE_MODE=stubborn ignore SIGTERM, must be SIGKILLed
//   FAKE_MODE=instant  exit(1) immediately (unstartable config)
const mode = process.env.FAKE_MODE ?? "normal";
if (mode === "instant") {
  process.stderr.write("KeyError: 'username'\n");
  process.exit(1);
}
process.stdout.write("miner started\n");
if (mode === "stubborn") {
  process.on("SIGTERM", () => process.stdout.write("ignoring SIGTERM\n"));
} else {
  process.on("SIGTERM", () => { process.stdout.write("shutting down\n"); process.exit(0); });
}
setInterval(() => {}, 1000);
```

- [ ] **Step 2: Write the failing log buffer test**

`apps/backend/src/miner/logBuffer.test.ts`:
```ts
import { expect, test } from "vitest";
import { LogBuffer } from "./logBuffer.js";

test("keeps only the most recent lines", () => {
  const buffer = new LogBuffer(3);
  for (const line of ["a", "b", "c", "d"]) buffer.push(line);
  expect(buffer.lines()).toEqual(["b", "c", "d"]);
});

test("splits multi-line chunks", () => {
  const buffer = new LogBuffer(10);
  buffer.push("one\ntwo\n");
  expect(buffer.lines()).toEqual(["one", "two"]);
});

test("ignores empty lines", () => {
  const buffer = new LogBuffer(10);
  buffer.push("\n\n");
  expect(buffer.lines()).toEqual([]);
});
```

- [ ] **Step 3: Implement the log buffer**

`apps/backend/src/miner/logBuffer.ts`:
```ts
/** Ring buffer of miner output. Display only — never parsed for state. */
export class LogBuffer {
  private buffer: string[] = [];
  constructor(private readonly capacity = 2000) {}

  push(chunk: string): void {
    for (const line of chunk.split("\n")) {
      if (line.trim() === "") continue;
      this.buffer.push(line);
    }
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }

  lines(): string[] {
    return [...this.buffer];
  }
}
```

- [ ] **Step 4: Run the log buffer test**

Run: `pnpm --filter @app/backend test logBuffer`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing supervisor test**

`apps/backend/src/miner/supervisor.test.ts`:
```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Supervisor } from "./supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "../../test/fixtures/fake-miner.mjs");

let sup: Supervisor;
afterEach(async () => { await sup?.stop(); });

function make(mode: string, overrides = {}) {
  sup = new Supervisor({
    command: process.execPath,
    args: [fake],
    cwd: process.cwd(),
    env: { FAKE_MODE: mode },
    graceMs: 300,
    fastExitMs: 500,
    backoffBaseMs: 10,
    maxRestarts: 3,
    ...overrides,
  });
  return sup;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("start moves through STARTING to RUNNING", async () => {
  const seen: string[] = [];
  const s = make("normal");
  s.on("state", (state) => seen.push(state));
  await s.start();
  expect(s.state).toBe("RUNNING");
  expect(seen).toContain("STARTING");
});

test("captures miner stdout into the log buffer", async () => {
  const s = make("normal");
  await s.start();
  await settle(100);
  expect(s.logs().join("\n")).toContain("miner started");
});

test("stop terminates a well-behaved miner with SIGTERM", async () => {
  const s = make("normal");
  await s.start();
  await s.stop();
  expect(s.state).toBe("STOPPED");
});

test("escalates to SIGKILL when SIGTERM is ignored", async () => {
  const s = make("stubborn");
  await s.start();
  const started = Date.now();
  await s.stop();
  expect(s.state).toBe("STOPPED");
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
});

test("a miner that exits immediately parks in CRASHED without looping", async () => {
  const s = make("instant");
  await s.start();
  await settle(400);
  expect(s.state).toBe("CRASHED");
  expect(s.restartCount).toBeLessThanOrEqual(1);
});

test("CRASHED surfaces the last log lines for diagnosis", async () => {
  const s = make("instant");
  await s.start();
  await settle(400);
  expect(s.logs().join("\n")).toContain("KeyError");
});

test("restart serializes so two callers cannot fork two miners", async () => {
  const s = make("normal");
  await s.start();
  await Promise.all([s.restart(), s.restart(), s.restart()]);
  expect(s.state).toBe("RUNNING");
  expect(s.livePids().length).toBe(1);
});

test("stop after crash is a no-op, not an error", async () => {
  const s = make("instant");
  await s.start();
  await settle(400);
  await expect(s.stop()).resolves.toBeUndefined();
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @app/backend test supervisor`
Expected: FAIL — cannot resolve `./supervisor.js`

- [ ] **Step 7: Write the implementation**

`apps/backend/src/miner/supervisor.ts`:
```ts
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { LogBuffer } from "./logBuffer.js";

export type MinerState =
  | "STOPPED" | "STARTING" | "RUNNING" | "RESTARTING" | "CRASHED";

export interface SupervisorOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** How long to wait for a clean SIGTERM shutdown before SIGKILL. */
  graceMs?: number;
  /** An exit sooner than this means the config is unstartable. */
  fastExitMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  maxRestarts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Supervisor extends EventEmitter {
  state: MinerState = "STOPPED";
  restartCount = 0;
  private child: ChildProcess | null = null;
  private buffer = new LogBuffer();
  private lock: Promise<void> = Promise.resolve();
  private intentionalStop = false;
  private startedAt = 0;

  constructor(private readonly options: SupervisorOptions) {
    super();
  }

  private get grace() { return this.options.graceMs ?? 20_000; }
  private get fastExit() { return this.options.fastExitMs ?? 10_000; }

  private setState(state: MinerState): void {
    this.state = state;
    this.emit("state", state);
  }

  /** Serializes every lifecycle operation so concurrent callers cannot race. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  logs(): string[] { return this.buffer.lines(); }

  livePids(): number[] {
    return this.child && this.child.exitCode === null && this.child.pid
      ? [this.child.pid]
      : [];
  }

  start(): Promise<void> {
    return this.serialize(() => this.spawnOnce());
  }

  private async spawnOnce(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    this.setState("STARTING");
    this.intentionalStop = false;
    this.startedAt = Date.now();
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => this.buffer.push(String(d)));
    child.stderr?.on("data", (d) => this.buffer.push(String(d)));
    child.on("exit", (code) => this.onExit(code));
    this.child = child;
    this.setState("RUNNING");
  }

  private onExit(code: number | null): void {
    const uptime = Date.now() - this.startedAt;
    this.child = null;
    if (this.intentionalStop) {
      this.setState("STOPPED");
      return;
    }
    if (uptime < this.fastExit) {
      // Exited almost immediately: the config or environment is broken.
      // Retrying cannot help and risks hammering Twitch auth.
      this.buffer.push(`miner exited after ${uptime}ms with code ${code}`);
      this.setState("CRASHED");
      return;
    }
    void this.scheduleRestart(code);
  }

  private async scheduleRestart(code: number | null): Promise<void> {
    if (this.restartCount >= (this.options.maxRestarts ?? 5)) {
      this.buffer.push(`giving up after ${this.restartCount} restarts`);
      this.setState("CRASHED");
      return;
    }
    const base = this.options.backoffBaseMs ?? 1000;
    const cap = this.options.backoffCapMs ?? 300_000;
    const delay = Math.min(base * 2 ** this.restartCount, cap);
    this.restartCount += 1;
    this.buffer.push(`miner exited (code ${code}); restarting in ${delay}ms`);
    await sleep(delay);
    await this.serialize(() => this.spawnOnce());
  }

  stop(): Promise<void> {
    return this.serialize(() => this.terminate());
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.setState("STOPPED");
      return;
    }
    this.intentionalStop = true;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    const timedOut = Symbol("timeout");
    const outcome = await Promise.race([
      exited.then(() => "exited" as const),
      sleep(this.grace).then(() => timedOut),
    ]);
    if (outcome === timedOut) {
      this.buffer.push("miner ignored SIGTERM; sending SIGKILL");
      child.kill("SIGKILL");
      await exited;
    }
    this.setState("STOPPED");
  }

  restart(): Promise<void> {
    return this.serialize(async () => {
      this.setState("RESTARTING");
      await this.terminate();
      this.restartCount = 0;
      await this.spawnOnce();
    });
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @app/backend test supervisor`
Expected: PASS (8 tests)

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/miner apps/backend/test/fixtures/fake-miner.mjs
git commit -m "feat: add miner supervisor with graceful shutdown and backoff"
```

---

## Task 11: Login runner

**Files:**
- Create: `apps/backend/src/helpers/loginRunner.ts`
- Test: `apps/backend/src/helpers/loginRunner.test.ts`
- Create: `apps/backend/test/fixtures/fake-login.mjs`

**Interfaces:**
- Consumes: the NDJSON stages from Task 7
- Produces: `class LoginRunner { start(): void; readonly current: LoginProgress | null; on("progress", (p: LoginProgress) => void); cancel(): void }` where `type LoginProgress = { stage: "code"; userCode: string; verificationUri: string; expiresAt: number } | { stage: "pending" } | { stage: "ok"; username: string } | { stage: "error"; error: string }`

- [ ] **Step 1: Write the fixture**

`apps/backend/test/fixtures/fake-login.mjs`:
```js
const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
emit({ stage: "code", userCode: "ABCD1234",
       verificationUri: "https://www.twitch.tv/activate", expiresAt: 999 });
emit({ stage: "pending" });
if (process.env.FAKE_LOGIN === "fail") {
  emit({ stage: "error", error: "token rejected by Twitch" });
  process.exit(1);
}
emit({ stage: "ok", username: "alex" });
```

- [ ] **Step 2: Write the failing test**

`apps/backend/src/helpers/loginRunner.test.ts`:
```ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { LoginRunner, type LoginProgress } from "./loginRunner.js";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "../../test/fixtures/fake-login.mjs");

function run(env: Record<string, string> = {}) {
  const runner = new LoginRunner({
    command: process.execPath, args: [fake], cwd: process.cwd(), env,
  });
  const seen: LoginProgress[] = [];
  runner.on("progress", (p) => seen.push(p));
  return new Promise<LoginProgress[]>((resolve) => {
    runner.on("done", () => resolve(seen));
    runner.start();
  });
}

test("emits the device code for the UI to display", async () => {
  const seen = await run();
  expect(seen[0]).toEqual({
    stage: "code", userCode: "ABCD1234",
    verificationUri: "https://www.twitch.tv/activate", expiresAt: 999,
  });
});

test("reaches ok on success", async () => {
  expect((await run()).at(-1)).toEqual({ stage: "ok", username: "alex" });
});

test("surfaces an error stage on failure", async () => {
  const last = (await run({ FAKE_LOGIN: "fail" })).at(-1);
  expect(last).toEqual({ stage: "error", error: "token rejected by Twitch" });
});

test("current exposes the latest progress for late subscribers", async () => {
  const runner = new LoginRunner({
    command: process.execPath, args: [fake], cwd: process.cwd(), env: {},
  });
  await new Promise<void>((resolve) => {
    runner.on("done", () => resolve());
    runner.start();
  });
  expect(runner.current).toEqual({ stage: "ok", username: "alex" });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @app/backend test loginRunner`
Expected: FAIL — cannot resolve `./loginRunner.js`

- [ ] **Step 4: Write the implementation**

`apps/backend/src/helpers/loginRunner.ts`:
```ts
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export type LoginProgress =
  | { stage: "code"; userCode: string; verificationUri: string; expiresAt: number }
  | { stage: "pending" }
  | { stage: "ok"; username: string }
  | { stage: "error"; error: string };

export interface LoginRunnerOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export class LoginRunner extends EventEmitter {
  current: LoginProgress | null = null;
  private child: ChildProcess | null = null;

  constructor(private readonly options: LoginRunnerOptions) {
    super();
  }

  start(): void {
    if (this.child) return;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let progress: LoginProgress;
      try {
        progress = JSON.parse(line) as LoginProgress;
      } catch {
        return;
      }
      this.current = progress;
      this.emit("progress", progress);
    });
    child.on("exit", () => {
      if (this.current === null || this.current.stage === "pending") {
        this.current = { stage: "error", error: "login helper exited unexpectedly" };
        this.emit("progress", this.current);
      }
      this.child = null;
      this.emit("done", this.current);
    });
    this.child = child;
  }

  cancel(): void {
    this.child?.kill("SIGTERM");
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @app/backend test loginRunner`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/helpers/loginRunner.ts apps/backend/src/helpers/loginRunner.test.ts apps/backend/test/fixtures/fake-login.mjs
git commit -m "feat: add device-code login runner"
```

---

## Task 12: SQLite history store

**Files:**
- Create: `apps/backend/src/db/schema.ts`, `apps/backend/src/db/history.ts`
- Test: `apps/backend/src/db/history.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `openDb(path: string): Database`, `class History { constructor(db: Database); recordPoints(username: string, balance: number, ts?: number): boolean; recordEvent(type: string, ts?: number): void; pointsSeries(username: string, fromTs: number, toTs: number): Array<{ts: number; balance: number}>; recentEvents(limit: number): Array<{ts: number; type: string}>; latest(username: string): number | null }`

- [ ] **Step 1: Write the failing test**

`apps/backend/src/db/history.test.ts`:
```ts
import { beforeEach, expect, test } from "vitest";
import { openDb } from "./schema.js";
import { History } from "./history.js";

let history: History;
beforeEach(() => { history = new History(openDb(":memory:")); });

test("records a first balance", () => {
  expect(history.recordPoints("alpha", 100, 1000)).toBe(true);
  expect(history.pointsSeries("alpha", 0, 9999)).toEqual([{ ts: 1000, balance: 100 }]);
});

test("skips writes when the balance has not changed", () => {
  history.recordPoints("alpha", 100, 1000);
  expect(history.recordPoints("alpha", 100, 2000)).toBe(false);
  expect(history.pointsSeries("alpha", 0, 9999)).toHaveLength(1);
});

test("records a write when the balance changes", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("alpha", 150, 2000);
  expect(history.pointsSeries("alpha", 0, 9999)).toEqual([
    { ts: 1000, balance: 100 },
    { ts: 2000, balance: 150 },
  ]);
});

test("tracks streamers independently", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("beta", 100, 1000);
  expect(history.recordPoints("beta", 200, 2000)).toBe(true);
  expect(history.latest("alpha")).toBe(100);
  expect(history.latest("beta")).toBe(200);
});

test("filters the series by time range", () => {
  history.recordPoints("alpha", 1, 1000);
  history.recordPoints("alpha", 2, 2000);
  history.recordPoints("alpha", 3, 3000);
  expect(history.pointsSeries("alpha", 1500, 2500)).toEqual([{ ts: 2000, balance: 2 }]);
});

test("latest returns null for an unknown streamer", () => {
  expect(history.latest("ghost")).toBe(null);
});

test("stores event types only, never message text", () => {
  history.recordEvent("STREAMER_ONLINE", 1000);
  history.recordEvent("GAIN_FOR_CLAIM", 2000);
  expect(history.recentEvents(10)).toEqual([
    { ts: 2000, type: "GAIN_FOR_CLAIM" },
    { ts: 1000, type: "STREAMER_ONLINE" },
  ]);
});

test("recentEvents respects the limit and returns newest first", () => {
  for (let i = 1; i <= 5; i++) history.recordEvent("BONUS_CLAIM", i * 1000);
  expect(history.recentEvents(2).map((e) => e.ts)).toEqual([5000, 4000]);
});

test("reopening the same database keeps the data", () => {
  const db = openDb(":memory:");
  const first = new History(db);
  first.recordPoints("alpha", 42, 1000);
  expect(new History(db).latest("alpha")).toBe(42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/backend test history`
Expected: FAIL — cannot resolve `./schema.js`

- [ ] **Step 3: Write the schema**

`apps/backend/src/db/schema.ts`:
```ts
import Database from "better-sqlite3";

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS point_snapshots (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer TEXT    NOT NULL,
      ts       INTEGER NOT NULL,
      balance  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_streamer_ts
      ON point_snapshots (streamer, ts);

    CREATE TABLE IF NOT EXISTS events (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      ts   INTEGER NOT NULL,
      type TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
  `);
  return db;
}
```

- [ ] **Step 4: Write the history store**

`apps/backend/src/db/history.ts`:
```ts
import type { Db } from "./schema.js";

export interface PointSample { ts: number; balance: number }
export interface EventSample { ts: number; type: string }

export class History {
  constructor(private readonly db: Db) {}

  /** Writes only on change. Returns whether a row was inserted. */
  recordPoints(username: string, balance: number, ts = Date.now()): boolean {
    if (this.latest(username) === balance) return false;
    this.db
      .prepare("INSERT INTO point_snapshots (streamer, ts, balance) VALUES (?, ?, ?)")
      .run(username, ts, balance);
    return true;
  }

  latest(username: string): number | null {
    const row = this.db
      .prepare(
        "SELECT balance FROM point_snapshots WHERE streamer = ? ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(username) as { balance: number } | undefined;
    return row ? row.balance : null;
  }

  pointsSeries(username: string, fromTs: number, toTs: number): PointSample[] {
    return this.db
      .prepare(
        "SELECT ts, balance FROM point_snapshots WHERE streamer = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC",
      )
      .all(username, fromTs, toTs) as PointSample[];
  }

  /** Event type only. Message text is lossy and must never be stored. */
  recordEvent(type: string, ts = Date.now()): void {
    this.db.prepare("INSERT INTO events (ts, type) VALUES (?, ?)").run(ts, type);
  }

  recentEvents(limit: number): EventSample[] {
    return this.db
      .prepare("SELECT ts, type FROM events ORDER BY ts DESC, id DESC LIMIT ?")
      .all(limit) as EventSample[];
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @app/backend test history`
Expected: PASS (9 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/db
git commit -m "feat: add SQLite history store for points and events"
```

---

## Task 13: State service

**Files:**
- Create: `apps/backend/src/state/service.ts`
- Test: `apps/backend/src/state/service.test.ts`

**Interfaces:**
- Consumes: `NdjsonClient` (Task 9), `History` (Task 12), `AppConfig` (Task 8)
- Produces: `class StateService { constructor(deps: {client: Pick<NdjsonClient,"request">; history: History; getStreamers: () => string[]; intervalMs?: number; debounceMs?: number; staleAfterMs?: number; now?: () => number}); refresh(): Promise<void>; ring(eventType: string): void; snapshot(): StateSnapshot; start(): void; stop(): void; on("change", (s: StateSnapshot) => void) }` where `StateSnapshot = { streamers: StreamerState[]; lastUpdated: number | null; stale: boolean; error: string | null }`

- [ ] **Step 1: Write the failing test**

`apps/backend/src/state/service.test.ts`:
```ts
import { beforeEach, expect, test, vi } from "vitest";
import { History } from "../db/history.js";
import { openDb } from "../db/schema.js";
import { StateService } from "./service.js";

let history: History;
let clock: number;
beforeEach(() => {
  history = new History(openDb(":memory:"));
  clock = 10_000;
});

function make(responses: unknown[], streamers = ["alpha"]) {
  const queue = [...responses];
  const request = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const service = new StateService({
    client: { request } as never,
    history,
    getStreamers: () => streamers,
    staleAfterMs: 1000,
    debounceMs: 50,
    now: () => clock,
  });
  return { service, request };
}

const alpha = (points: number, isOnline = true) => ({
  streamers: [{
    username: "alpha", channelId: "42", displayName: "Alpha",
    points, isOnline, pointsEnabled: true,
  }],
});

test("refresh publishes streamer state with a timestamp", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  const snap = service.snapshot();
  expect(snap.streamers[0].points).toBe(100);
  expect(snap.lastUpdated).toBe(10_000);
  expect(snap.stale).toBe(false);
});

test("refresh writes a point snapshot to history", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  expect(history.latest("alpha")).toBe(100);
});

test("emits change only when something actually changed", async () => {
  const { service } = make([alpha(100), alpha(100), alpha(150)]);
  const changes: number[] = [];
  service.on("change", () => changes.push(1));
  await service.refresh();
  await service.refresh();
  await service.refresh();
  expect(changes.length).toBe(2);
});

test("state goes stale once the refresh is older than staleAfterMs", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  expect(service.snapshot().stale).toBe(false);
  clock += 5000;
  expect(service.snapshot().stale).toBe(true);
});

test("a failed refresh keeps the last good numbers but marks them stale", async () => {
  const { service } = make([alpha(100), new Error("gql exploded")]);
  await service.refresh();
  clock += 1;
  await service.refresh();
  const snap = service.snapshot();
  expect(snap.streamers[0].points).toBe(100);
  expect(snap.stale).toBe(true);
  expect(snap.error).toContain("gql exploded");
});

test("a successful refresh clears a previous error", async () => {
  const { service } = make([new Error("boom"), alpha(100)]);
  await service.refresh();
  await service.refresh();
  expect(service.snapshot().error).toBe(null);
});

test("ring coalesces a burst into a single refresh", async () => {
  vi.useFakeTimers();
  const { service, request } = make([alpha(100), alpha(100), alpha(100)]);
  for (let i = 0; i < 5; i++) service.ring("GAIN_FOR_RAID");
  await vi.advanceTimersByTimeAsync(200);
  expect(request).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("ring records the event type in history", () => {
  const { service } = make([alpha(100)]);
  service.ring("STREAMER_ONLINE");
  expect(history.recentEvents(1)[0].type).toBe("STREAMER_ONLINE");
});

test("requests exactly the configured streamers", async () => {
  const { service, request } = make([{ streamers: [] }], ["a", "b"]);
  await service.refresh();
  expect(request).toHaveBeenCalledWith("state", { streamers: ["a", "b"] });
});

test("skips the round trip when no streamers are configured", async () => {
  const { service, request } = make([], []);
  await service.refresh();
  expect(request).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/backend test service`
Expected: FAIL — cannot resolve `./service.js`

- [ ] **Step 3: Write the implementation**

`apps/backend/src/state/service.ts`:
```ts
import { EventEmitter } from "node:events";
import type { History } from "../db/history.js";

export interface StreamerState {
  username: string;
  channelId: string | null;
  displayName: string | null;
  points: number | null;
  isOnline: boolean | null;
  pointsEnabled: boolean | null;
  error?: string;
}

export interface StateSnapshot {
  streamers: StreamerState[];
  lastUpdated: number | null;
  stale: boolean;
  error: string | null;
}

export interface StateServiceDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
  history: History;
  getStreamers: () => string[];
  intervalMs?: number;
  debounceMs?: number;
  staleAfterMs?: number;
  now?: () => number;
}

export class StateService extends EventEmitter {
  private streamers: StreamerState[] = [];
  private lastUpdated: number | null = null;
  private lastError: string | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: StateServiceDeps) {
    super();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  snapshot(): StateSnapshot {
    const staleAfter = this.deps.staleAfterMs ?? 180_000;
    const age = this.lastUpdated === null ? Infinity : this.now() - this.lastUpdated;
    return {
      streamers: this.streamers,
      lastUpdated: this.lastUpdated,
      stale: age > staleAfter,
      error: this.lastError,
    };
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    const usernames = this.deps.getStreamers();
    if (usernames.length === 0) {
      this.streamers = [];
      return;
    }
    try {
      const data = await this.deps.client.request<{ streamers: StreamerState[] }>(
        "state", { streamers: usernames },
      );
      const before = JSON.stringify(this.streamers);
      this.streamers = data.streamers;
      this.lastUpdated = this.now();
      this.lastError = null;
      for (const s of data.streamers) {
        if (typeof s.points === "number") {
          this.deps.history.recordPoints(s.username, s.points, this.lastUpdated);
        }
      }
      if (before !== JSON.stringify(this.streamers)) {
        this.emit("change", this.snapshot());
      }
    } catch (cause) {
      // Keep the last known numbers; snapshot() will report them as stale.
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      this.emit("change", this.snapshot());
    }
  }

  /** Doorbell: something happened, refresh soon. Bursts coalesce. */
  ring(eventType: string): void {
    this.deps.history.recordEvent(eventType, this.now());
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh();
    }, this.deps.debounceMs ?? 2000);
  }

  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.refresh(), this.deps.intervalMs ?? 60_000);
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.ticker = null;
    this.debounceTimer = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @app/backend test service`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/state
git commit -m "feat: add state service with debounced refresh and staleness"
```

---

## Task 14: HTTP server, session auth, and SSE

**Files:**
- Create: `apps/backend/src/http/auth.ts`, `apps/backend/src/http/sse.ts`, `apps/backend/src/http/server.ts`
- Test: `apps/backend/src/http/auth.test.ts`, `apps/backend/src/http/sse.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `registerAuth(app, opts: {password: string}): void`, `class SseHub { register(app): void; broadcast(event: string, data: unknown): void; readonly clientCount: number }`, `buildServer(deps: ServerDeps): FastifyInstance`

- [ ] **Step 1: Write the failing auth test**

`apps/backend/src/http/auth.test.ts`:
```ts
import Fastify from "fastify";
import { expect, test } from "vitest";
import { registerAuth } from "./auth.js";

async function app(password = "hunter2") {
  const instance = Fastify();
  await registerAuth(instance, { password });
  instance.get("/api/protected", async () => ({ ok: true }));
  return instance;
}

test("rejects an unauthenticated request", async () => {
  const res = await (await app()).inject({ method: "GET", url: "/api/protected" });
  expect(res.statusCode).toBe(401);
});

test("rejects the wrong password", async () => {
  const res = await (await app()).inject({
    method: "POST", url: "/api/session", payload: { password: "wrong" },
  });
  expect(res.statusCode).toBe(401);
});

test("issues a session cookie for the right password", async () => {
  const res = await (await app()).inject({
    method: "POST", url: "/api/session", payload: { password: "hunter2" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.cookies[0].name).toBe("session");
  expect(res.cookies[0].httpOnly).toBe(true);
});

test("accepts a protected request with a valid session cookie", async () => {
  const instance = await app();
  const login = await instance.inject({
    method: "POST", url: "/api/session", payload: { password: "hunter2" },
  });
  const res = await instance.inject({
    method: "GET", url: "/api/protected",
    cookies: { session: login.cookies[0].value },
  });
  expect(res.statusCode).toBe(200);
});

test("rejects a forged session cookie", async () => {
  const res = await (await app()).inject({
    method: "GET", url: "/api/protected", cookies: { session: "made-up" },
  });
  expect(res.statusCode).toBe(401);
});

test("does not require auth for the internal doorbell path", async () => {
  const instance = await app();
  instance.post("/internal/doorbell", async () => ({ ok: true }));
  const res = await instance.inject({ method: "POST", url: "/internal/doorbell" });
  expect(res.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/backend test auth`
Expected: FAIL — cannot resolve `./auth.js`

- [ ] **Step 3: Write the auth plugin**

`apps/backend/src/http/auth.ts`:
```ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import cookie from "@fastify/cookie";
import type { FastifyInstance } from "fastify";

const sessions = new Set<string>();

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function registerAuth(
  app: FastifyInstance,
  opts: { password: string },
): Promise<void> {
  await app.register(cookie);

  app.post("/api/session", async (request, reply) => {
    const body = request.body as { password?: string } | undefined;
    if (!body?.password || !sameSecret(body.password, opts.password)) {
      return reply.code(401).send({ error: "invalid password" });
    }
    const token = randomBytes(32).toString("hex");
    sessions.add(token);
    return reply
      .setCookie("session", token, {
        httpOnly: true, sameSite: "lax", path: "/",
      })
      .send({ ok: true });
  });

  app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0];
    if (url === "/api/session") return;
    // The doorbell is authenticated by its own shared token, not a session.
    if (url.startsWith("/internal/")) return;
    if (!url.startsWith("/api/")) return;
    const token = request.cookies?.session;
    if (!token || !sessions.has(token)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });
}
```

- [ ] **Step 4: Run the auth test**

Run: `pnpm --filter @app/backend test auth`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing SSE test**

`apps/backend/src/http/sse.test.ts`:
```ts
import Fastify from "fastify";
import { expect, test } from "vitest";
import { SseHub } from "./sse.js";

test("a broadcast with no clients does not throw", () => {
  expect(() => new SseHub().broadcast("state", { a: 1 })).not.toThrow();
});

test("formats a frame as SSE wire format", () => {
  const hub = new SseHub();
  expect(hub.frame("state", { a: 1 })).toBe('event: state\ndata: {"a":1}\n\n');
});

test("tracks client count across connect and disconnect", async () => {
  const app = Fastify();
  const hub = new SseHub();
  hub.register(app);
  await app.listen({ port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
    signal: controller.signal,
  });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  await new Promise((r) => setTimeout(r, 50));
  expect(hub.clientCount).toBe(1);

  controller.abort();
  await new Promise((r) => setTimeout(r, 50));
  expect(hub.clientCount).toBe(0);
  await app.close();
});
```

- [ ] **Step 6: Write the SSE hub**

`apps/backend/src/http/sse.ts`:
```ts
import type { FastifyInstance, FastifyReply } from "fastify";

export class SseHub {
  private clients = new Set<FastifyReply>();

  get clientCount(): number {
    return this.clients.size;
  }

  frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  broadcast(event: string, data: unknown): void {
    const payload = this.frame(event, data);
    for (const reply of this.clients) {
      try {
        reply.raw.write(payload);
      } catch {
        this.clients.delete(reply);
      }
    }
  }

  register(app: FastifyInstance): void {
    app.get("/api/stream", (request, reply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      reply.raw.write(": connected\n\n");
      this.clients.add(reply);
      request.raw.on("close", () => { this.clients.delete(reply); });
    });
  }
}
```

- [ ] **Step 7: Run the SSE test**

Run: `pnpm --filter @app/backend test sse`
Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/http/auth.ts apps/backend/src/http/sse.ts apps/backend/src/http/auth.test.ts apps/backend/src/http/sse.test.ts
git commit -m "feat: add session auth and SSE broadcasting"
```

---

## Task 15: API routes and server assembly

**Files:**
- Create: `apps/backend/src/http/routes.config.ts`, `routes.miner.ts`, `routes.state.ts`, `routes.login.ts`, `routes.internal.ts`, `apps/backend/src/http/server.ts`, `apps/backend/src/index.ts`
- Test: `apps/backend/src/http/server.test.ts`

**Interfaces:**
- Consumes: `loadConfig`/`saveConfig` (Task 8), `NdjsonClient` (Task 9), `Supervisor` (Task 10), `LoginRunner` (Task 11), `History` (Task 12), `StateService` (Task 13), `SseHub`/`registerAuth` (Task 14)
- Produces: `buildServer(deps: ServerDeps): FastifyInstance` with the route surface from the spec

- [ ] **Step 1: Write the failing test**

`apps/backend/src/http/server.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { History } from "../db/history.js";
import { openDb } from "../db/schema.js";
import { StateService } from "../state/service.js";
import { buildServer } from "./server.js";

const PASSWORD = "hunter2";
const validConfig = {
  version: 1, username: "alex", followers: true, followersOrder: "ASC",
  defaults: {}, streamers: [{ username: "alpha", enabled: true, settings: {} }],
};

let ctx: Awaited<ReturnType<typeof make>>;

async function make() {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  const history = new History(openDb(":memory:"));
  const supervisor = {
    state: "RUNNING" as const, restart: vi.fn(async () => {}),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    logs: () => ["line one", "line two"], on: vi.fn(),
  };
  const client = { request: vi.fn(async () => ({ streamers: [] })) };
  const state = new StateService({
    client: client as never, history, getStreamers: () => ["alpha"],
  });
  const loginRunner = { current: null, start: vi.fn(), on: vi.fn(), cancel: vi.fn() };
  const app = buildServer({
    configPath: join(dir, "config.json"),
    password: PASSWORD,
    doorbellToken: "doorbell-token",
    supervisor: supervisor as never,
    stateService: state,
    history,
    helper: client as never,
    loginRunner: loginRunner as never,
  });
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/api/session", payload: { password: PASSWORD },
  });
  return { app, supervisor, client, history, cookie: login.cookies[0].value };
}

beforeEach(async () => { ctx = await make(); });

const auth = () => ({ session: ctx.cookie });

test("GET /api/config returns defaults before anything is saved", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/config", cookies: auth() });
  expect(res.statusCode).toBe(200);
  expect(res.json().streamers).toEqual([]);
});

test("PUT /api/config stages without restarting the miner", async () => {
  const res = await ctx.app.inject({
    method: "PUT", url: "/api/config", cookies: auth(), payload: validConfig,
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.supervisor.restart).not.toHaveBeenCalled();
  expect(res.json().pending).toBe(true);
});

test("PUT /api/config rejects an invalid config with 400", async () => {
  const res = await ctx.app.inject({
    method: "PUT", url: "/api/config", cookies: auth(),
    payload: { ...validConfig, streamers: [{ username: "!!", enabled: true, settings: {} }] },
  });
  expect(res.statusCode).toBe(400);
});

test("POST /api/config/apply writes the config and restarts", async () => {
  await ctx.app.inject({
    method: "PUT", url: "/api/config", cookies: auth(), payload: validConfig,
  });
  const res = await ctx.app.inject({
    method: "POST", url: "/api/config/apply", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.supervisor.restart).toHaveBeenCalledOnce();
  const saved = await ctx.app.inject({ method: "GET", url: "/api/config", cookies: auth() });
  expect(saved.json().streamers[0].username).toBe("alpha");
});

test("POST /api/config/apply with nothing staged does not restart", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/api/config/apply", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.supervisor.restart).not.toHaveBeenCalled();
});

test("GET /api/status reports supervisor state and staleness", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(res.json()).toMatchObject({ miner: "RUNNING", stale: true });
});

test("GET /api/status derives loginRequired when no Twitch account is set up", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(res.json().loginRequired).toBe(true);
});

test("POST /api/miner/restart delegates to the supervisor", async () => {
  await ctx.app.inject({ method: "POST", url: "/api/miner/restart", cookies: auth() });
  expect(ctx.supervisor.restart).toHaveBeenCalledOnce();
});

test("GET /api/logs returns the ring buffer", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/logs", cookies: auth() });
  expect(res.json().lines).toEqual(["line one", "line two"]);
});

test("GET /api/streamers/lookup proxies to the helper", async () => {
  ctx.client.request.mockResolvedValueOnce({
    username: "alpha", channelId: "42", exists: true,
  });
  const res = await ctx.app.inject({
    method: "GET", url: "/api/streamers/lookup?q=alpha", cookies: auth(),
  });
  expect(res.json().exists).toBe(true);
});

test("GET /api/streamers/lookup rejects a malformed username without calling Twitch", async () => {
  const before = ctx.client.request.mock.calls.length;
  const res = await ctx.app.inject({
    method: "GET", url: "/api/streamers/lookup?q=a", cookies: auth(),
  });
  expect(res.statusCode).toBe(400);
  expect(ctx.client.request.mock.calls.length).toBe(before);
});

test("GET /api/history returns a series", async () => {
  ctx.history.recordPoints("alpha", 10, 1000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().series).toEqual([{ ts: 1000, balance: 10 }]);
});

test("doorbell with the right token rings the state service", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "doorbell-token" },
    payload: { event: "STREAMER_ONLINE", ts: 1 },
  });
  expect(res.statusCode).toBe(204);
  expect(ctx.history.recentEvents(1)[0].type).toBe("STREAMER_ONLINE");
});

test("doorbell with a wrong token is rejected", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "nope" },
    payload: { event: "STREAMER_ONLINE", ts: 1 },
  });
  expect(res.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/backend test server`
Expected: FAIL — cannot resolve `./server.js`

- [ ] **Step 3: Write the server**

`apps/backend/src/http/server.ts`:
```ts
import Fastify, { type FastifyInstance } from "fastify";
import { type AppConfig, configSchema, usernameSchema } from "../config/schema.js";
import { loadConfig, saveConfig } from "../config/store.js";
import type { History } from "../db/history.js";
import type { LoginRunner } from "../helpers/loginRunner.js";
import type { NdjsonClient } from "../helpers/ndjsonClient.js";
import type { Supervisor } from "../miner/supervisor.js";
import type { StateService } from "../state/service.js";
import { registerAuth } from "./auth.js";
import { SseHub } from "./sse.js";

export interface ServerDeps {
  configPath: string;
  password: string;
  doorbellToken: string;
  supervisor: Supervisor;
  stateService: StateService;
  history: History;
  helper: NdjsonClient;
  loginRunner: LoginRunner;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const hub = new SseHub();
  let staged: AppConfig | null = null;

  app.register(async (instance) => {
    await registerAuth(instance, { password: deps.password });
    hub.register(instance);

    instance.get("/api/config", async () =>
      staged ?? loadConfig(deps.configPath),
    );

    instance.put("/api/config", async (request, reply) => {
      const parsed = configSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      staged = parsed.data;
      return { pending: true };
    });

    instance.post("/api/config/apply", async () => {
      if (staged === null) return { applied: false };
      saveConfig(deps.configPath, staged);
      staged = null;
      await deps.supervisor.restart();
      return { applied: true };
    });

    instance.get("/api/status", async () => {
      const snapshot = deps.stateService.snapshot();
      // The spec lists LOGIN_REQUIRED among the lifecycle states, but the
      // supervisor only knows about processes, not Twitch auth. It is derived
      // here instead, from the login runner plus a missing username.
      const loginRequired =
        deps.loginRunner.current === null ||
        deps.loginRunner.current.stage === "error" ||
        loadConfig(deps.configPath).username === "";
      return {
        miner: deps.supervisor.state,
        loginRequired,
        login: deps.loginRunner.current,
        lastUpdated: snapshot.lastUpdated,
        stale: snapshot.stale,
        error: snapshot.error,
        pendingChanges: staged !== null,
      };
    });

    instance.get("/api/streamers", async () => deps.stateService.snapshot());

    instance.get("/api/followers", async () =>
      deps.helper.request("followers"),
    );

    instance.get("/api/streamers/lookup", async (request, reply) => {
      const q = (request.query as { q?: string }).q ?? "";
      if (!usernameSchema.safeParse(q).success) {
        return reply.code(400).send({ error: "not a valid Twitch username" });
      }
      return deps.helper.request("lookup", { username: q });
    });

    instance.get("/api/history", async (request) => {
      const q = request.query as { streamer: string; from: string; to: string };
      return {
        series: deps.history.pointsSeries(q.streamer, Number(q.from), Number(q.to)),
        events: deps.history.recentEvents(100),
      };
    });

    instance.get("/api/logs", async () => ({ lines: deps.supervisor.logs() }));

    for (const action of ["start", "stop", "restart"] as const) {
      instance.post(`/api/miner/${action}`, async () => {
        await deps.supervisor[action]();
        return { state: deps.supervisor.state };
      });
    }

    instance.post("/api/twitch/login", async () => {
      deps.loginRunner.start();
      return { started: true };
    });
  });

  app.post("/internal/doorbell", async (request, reply) => {
    if (request.headers["x-doorbell-token"] !== deps.doorbellToken) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const body = request.body as { event?: string };
    if (body?.event) deps.stateService.ring(body.event);
    return reply.code(204).send();
  });

  deps.stateService.on("change", (snapshot) => hub.broadcast("state", snapshot));
  deps.supervisor.on("state", (state) => hub.broadcast("miner", { state }));
  deps.loginRunner.on("progress", (p) => hub.broadcast("login", p));

  return app;
}
```

- [ ] **Step 4: Write the entry point**

`apps/backend/src/index.ts`:
```ts
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { History } from "./db/history.js";
import { openDb } from "./db/schema.js";
import { LoginRunner } from "./helpers/loginRunner.js";
import { NdjsonClient } from "./helpers/ndjsonClient.js";
import { Supervisor } from "./miner/supervisor.js";
import { StateService } from "./state/service.js";
import { buildServer } from "./http/server.js";
import { loadConfig } from "./config/store.js";

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const pythonDir = resolve(process.env.PYTHON_DIR ?? "./python");
const python = process.env.PYTHON_BIN ?? "python3";
const configPath = join(dataDir, "config.json");
const password = process.env.APP_PASSWORD;
if (!password) throw new Error("APP_PASSWORD is required");
const doorbellToken = randomBytes(24).toString("hex");
const port = Number(process.env.PORT ?? 8080);

const username = loadConfig(configPath).username;
const sharedEnv = { TWITCH_USERNAME: username, COOKIES_DIR: join(dataDir, "cookies") };

const helper = new NdjsonClient({
  command: python, args: [join(pythonDir, "helpers", "state.py")],
  cwd: dataDir, env: sharedEnv,
});
const loginRunner = new LoginRunner({
  command: python, args: [join(pythonDir, "helpers", "login.py")],
  cwd: dataDir, env: sharedEnv,
});
const supervisor = new Supervisor({
  command: python, args: [join(pythonDir, "run.py")], cwd: dataDir,
  env: {
    MINER_CONFIG: configPath,
    DOORBELL_TOKEN: doorbellToken,
    DOORBELL_URL: `http://127.0.0.1:${port}/internal/doorbell`,
  },
});
const history = new History(openDb(join(dataDir, "history.db")));
const stateService = new StateService({
  client: helper, history,
  getStreamers: () =>
    loadConfig(configPath).streamers.filter((s) => s.enabled).map((s) => s.username),
});

const app = buildServer({
  configPath, password, doorbellToken, supervisor, stateService, history,
  helper, loginRunner,
});

const loggedIn = await helper
  .request<{ loggedIn: boolean }>("check_login")
  .catch(() => ({ loggedIn: false }));

stateService.start();
if (loggedIn.loggedIn && username) await supervisor.start();

await app.listen({ port, host: "0.0.0.0" });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @app/backend test server`
Expected: PASS (14 tests)

- [ ] **Step 6: Run the whole backend suite**

Run: `pnpm --filter @app/backend test`
Expected: PASS (all backend tests from tasks 8-15)

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src
git commit -m "feat: add HTTP API surface and server assembly"
```

---

## Task 16: Frontend scaffold, API client, and auth gate

**Files:**
- Create: `apps/frontend/package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/api/client.ts`, `src/app.tsx`, `src/components/PasswordGate.tsx`
- Test: `apps/frontend/src/api/client.test.ts`, `apps/frontend/src/components/PasswordGate.test.tsx`

**Interfaces:**
- Consumes: the HTTP API from Task 15
- Produces: `api.get<T>(path)`, `api.post<T>(path, body)`, `api.put<T>(path, body)`, `UnauthorizedError`, and `<PasswordGate>` which renders children only once a session exists

- [ ] **Step 1: Create the frontend package**

`apps/frontend/package.json`:
```json
{
  "name": "@app/frontend",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "@mantine/core": "^8.0.0",
    "@mantine/hooks": "^8.0.0",
    "@tanstack/react-query": "^5.62.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "vite": "^7.0.0",
    "vitest": "^3.0.0"
  }
}
```

`apps/frontend/vite.config.ts`:
```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8080" } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
  },
});
```

`apps/frontend/src/test-setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 2: Write the failing API client test**

`apps/frontend/src/api/client.test.ts`:
```ts
import { afterEach, expect, test, vi } from "vitest";
import { UnauthorizedError, api } from "./client.js";

afterEach(() => { vi.unstubAllGlobals(); });

function stub(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("get returns parsed json", async () => {
  stub(200, { hello: "world" });
  await expect(api.get("/api/thing")).resolves.toEqual({ hello: "world" });
});

test("get sends credentials so the session cookie travels", async () => {
  const fetchMock = stub(200, {});
  await api.get("/api/thing");
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "same-origin" });
});

test("a 401 raises UnauthorizedError so the gate can react", async () => {
  stub(401, { error: "unauthorized" });
  await expect(api.get("/api/thing")).rejects.toBeInstanceOf(UnauthorizedError);
});

test("a 400 raises an error carrying the server message", async () => {
  stub(400, { error: "duplicate streamer" });
  await expect(api.put("/api/config", {})).rejects.toThrow("duplicate streamer");
});

test("post sends a json body", async () => {
  const fetchMock = stub(200, {});
  await api.post("/api/session", { password: "x" });
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  expect(init.method).toBe("POST");
  expect(init.body).toBe(JSON.stringify({ password: "x" }));
});
```

- [ ] **Step 3: Write the API client**

`apps/frontend/src/api/client.ts`:
```ts
export class UnauthorizedError extends Error {
  constructor() { super("unauthorized"); }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) throw new UnauthorizedError();
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error ?? `HTTP ${response.status}`);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => send<T>("GET", path),
  post: <T>(path: string, body?: unknown) => send<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => send<T>("PUT", path, body),
};
```

- [ ] **Step 4: Run the client test**

Run: `pnpm --filter @app/frontend test client`
Expected: PASS (5 tests)

- [ ] **Step 5: Write the failing gate test**

`apps/frontend/src/components/PasswordGate.test.tsx`:
```tsx
import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PasswordGate } from "./PasswordGate.js";

afterEach(() => { vi.unstubAllGlobals(); });

function stubSequence(...statuses: number[]) {
  const queue = [...statuses];
  vi.stubGlobal("fetch", vi.fn(async () => {
    const status = queue.shift() ?? 200;
    return { ok: status < 300, status, json: async () => ({}) };
  }));
}

const ui = (
  <MantineProvider>
    <PasswordGate><div>secret content</div></PasswordGate>
  </MantineProvider>
);

test("shows the password form when there is no session", async () => {
  stubSequence(401);
  render(ui);
  expect(await screen.findByLabelText(/password/i)).toBeInTheDocument();
  expect(screen.queryByText("secret content")).not.toBeInTheDocument();
});

test("renders children when a session already exists", async () => {
  stubSequence(200);
  render(ui);
  expect(await screen.findByText("secret content")).toBeInTheDocument();
});

test("unlocks after a successful login", async () => {
  stubSequence(401, 200, 200);
  render(ui);
  await userEvent.type(await screen.findByLabelText(/password/i), "hunter2");
  await userEvent.click(screen.getByRole("button", { name: /unlock/i }));
  expect(await screen.findByText("secret content")).toBeInTheDocument();
});

test("shows an error on a wrong password and stays locked", async () => {
  stubSequence(401, 401);
  render(ui);
  await userEvent.type(await screen.findByLabelText(/password/i), "wrong");
  await userEvent.click(screen.getByRole("button", { name: /unlock/i }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.queryByText("secret content")).not.toBeInTheDocument();
});
```

- [ ] **Step 6: Write the gate**

`apps/frontend/src/components/PasswordGate.tsx`:
```tsx
import { Alert, Button, Card, Center, PasswordInput, Stack } from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api/client.js";

export function PasswordGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get("/api/status").then(() => setUnlocked(true)).catch(() => setUnlocked(false));
  }, []);

  if (unlocked === null) return null;
  if (unlocked) return <>{children}</>;

  const submit = async () => {
    setError(null);
    try {
      await api.post("/api/session", { password });
      setUnlocked(true);
    } catch {
      setError("Wrong password");
    }
  };

  return (
    <Center h="100vh">
      <Card withBorder w={360} padding="lg">
        <Stack>
          {error && <Alert role="alert" color="red">{error}</Alert>}
          <PasswordInput
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
          <Button onClick={() => void submit()}>Unlock</Button>
        </Stack>
      </Card>
    </Center>
  );
}
```

- [ ] **Step 7: Run the gate test**

Run: `pnpm --filter @app/frontend test PasswordGate`
Expected: PASS (4 tests)

- [ ] **Step 8: Commit**

```bash
git add apps/frontend
git commit -m "feat: add frontend scaffold, api client and password gate"
```

---

## Task 17: Streamers screen with staged changes

This is the screen that delivers the original goal: change the streamer list without editing Python.

**Files:**
- Create: `apps/frontend/src/routes/Streamers.tsx`, `apps/frontend/src/components/PendingBar.tsx`, `apps/frontend/src/components/AddStreamer.tsx`
- Test: `apps/frontend/src/routes/Streamers.test.tsx`

**Interfaces:**
- Consumes: `api` (Task 16); endpoints `/api/config`, `/api/config/apply`, `/api/streamers/lookup`
- Produces: `<Streamers />`, `<PendingBar count onApply />`, `<AddStreamer onAdd />`

- [ ] **Step 1: Write the failing test**

`apps/frontend/src/routes/Streamers.test.tsx`:
```tsx
import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Streamers } from "./Streamers.js";

const config = {
  version: 1, username: "alex", followers: true, followersOrder: "ASC",
  defaults: {},
  streamers: [
    { username: "alpha", enabled: true, settings: {} },
    { username: "beta", enabled: true, settings: {} },
  ],
};

let calls: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("/api/streamers/lookup")) {
      const q = new URL(url, "http://x").searchParams.get("q");
      return { ok: true, status: 200,
               json: async () => ({ username: q, channelId: "1", exists: q !== "ghost" }) };
    }
    if (url === "/api/config" && (!init || init.method === "GET")) {
      return { ok: true, status: 200, json: async () => config };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const view = () => render(<MantineProvider><Streamers /></MantineProvider>);

test("lists configured streamers in priority order", async () => {
  view();
  const rows = await screen.findAllByTestId("streamer-row");
  expect(rows.map((r) => r.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining("alpha")]),
  );
  expect(rows[0].textContent).toContain("alpha");
  expect(rows[1].textContent).toContain("beta");
});

test("no apply bar until something changes", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  expect(screen.queryByTestId("pending-bar")).not.toBeInTheDocument();
});

test("toggling a streamer stages a change without restarting", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.click(screen.getAllByRole("switch")[0]);
  expect(await screen.findByTestId("pending-bar")).toHaveTextContent("1 pending change");
  expect(calls.some((c) => c.url === "/api/config/apply")).toBe(false);
});

test("apply sends the config then triggers the restart", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.click(screen.getAllByRole("switch")[0]);
  await userEvent.click(await screen.findByRole("button", { name: /apply & restart/i }));
  await waitFor(() => {
    expect(calls.some((c) => c.url === "/api/config" && c.init?.method === "PUT")).toBe(true);
    expect(calls.some((c) => c.url === "/api/config/apply")).toBe(true);
  });
});

test("adding a streamer validates the username against Twitch first", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.type(screen.getByLabelText(/add streamer/i), "gamma");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  await waitFor(() =>
    expect(calls.some((c) => c.url.includes("lookup?q=gamma"))).toBe(true),
  );
  expect(await screen.findByText("gamma")).toBeInTheDocument();
});

test("rejects a username Twitch does not know", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.type(screen.getByLabelText(/add streamer/i), "ghost");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/no such twitch user/i);
});

test("rejects adding a duplicate", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.type(screen.getByLabelText(/add streamer/i), "alpha");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/already/i);
});

test("moving a streamer up reorders priority and stages a change", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.click(screen.getAllByRole("button", { name: /move up/i })[1]);
  const rows = screen.getAllByTestId("streamer-row");
  expect(rows[0].textContent).toContain("beta");
  expect(await screen.findByTestId("pending-bar")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/frontend test Streamers`
Expected: FAIL — cannot resolve `./Streamers.js`

- [ ] **Step 3: Write the pending bar**

`apps/frontend/src/components/PendingBar.tsx`:
```tsx
import { Affix, Button, Group, Paper, Text } from "@mantine/core";

export function PendingBar({ count, onApply, busy }: {
  count: number; onApply: () => void; busy?: boolean;
}) {
  if (count === 0) return null;
  return (
    <Affix position={{ bottom: 0, left: 0, right: 0 }}>
      <Paper withBorder p="sm" radius={0} data-testid="pending-bar">
        <Group justify="space-between">
          <Text size="sm">
            {count} pending change{count === 1 ? "" : "s"} — the miner will restart
          </Text>
          <Button loading={busy} onClick={onApply}>Apply &amp; Restart</Button>
        </Group>
      </Paper>
    </Affix>
  );
}
```

- [ ] **Step 4: Write the add-streamer control**

`apps/frontend/src/components/AddStreamer.tsx`:
```tsx
import { Button, Group, TextInput } from "@mantine/core";
import { useState } from "react";

export function AddStreamer({ onAdd }: { onAdd: (username: string) => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await onAdd(value.trim());
      setValue("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group>
      <TextInput
        label="Add streamer"
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      <Button mt="lg" loading={busy} onClick={() => void submit()}>Add</Button>
    </Group>
  );
}
```

- [ ] **Step 5: Write the screen**

`apps/frontend/src/routes/Streamers.tsx`:
```tsx
import {
  ActionIcon, Alert, Card, Group, Stack, Switch, Text, Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { AddStreamer } from "../components/AddStreamer.js";
import { PendingBar } from "../components/PendingBar.js";

interface StreamerEntry {
  username: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}
interface Config {
  version: 1; username: string; followers: boolean; followersOrder: string;
  defaults: Record<string, unknown>; streamers: StreamerEntry[];
}

export function Streamers() {
  const [saved, setSaved] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Config>("/api/config").then((c) => { setSaved(c); setDraft(c); });
  }, []);

  if (!draft || !saved) return null;

  const changes = countChanges(saved.streamers, draft.streamers);

  const add = async (username: string) => {
    setError(null);
    if (draft.streamers.some((s) => s.username.toLowerCase() === username.toLowerCase())) {
      setError(`${username} is already in the list`);
      return;
    }
    const found = await api.get<{ exists: boolean }>(
      `/api/streamers/lookup?q=${encodeURIComponent(username)}`,
    );
    if (!found.exists) {
      setError(`No such Twitch user: ${username}`);
      return;
    }
    setDraft({
      ...draft,
      streamers: [...draft.streamers, { username, enabled: true, settings: {} }],
    });
  };

  const toggle = (index: number) => {
    const streamers = draft.streamers.map((s, i) =>
      i === index ? { ...s, enabled: !s.enabled } : s,
    );
    setDraft({ ...draft, streamers });
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const streamers = [...draft.streamers];
    [streamers[index - 1], streamers[index]] = [streamers[index], streamers[index - 1]];
    setDraft({ ...draft, streamers });
  };

  const apply = async () => {
    setBusy(true);
    try {
      await api.put("/api/config", draft);
      await api.post("/api/config/apply");
      setSaved(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack pb={80}>
      <Title order={2}>Streamers</Title>
      <Text size="sm" c="dimmed">Order is priority — the miner watches the top two.</Text>
      {error && <Alert role="alert" color="red">{error}</Alert>}
      <AddStreamer onAdd={add} />
      {draft.streamers.map((streamer, index) => (
        <Card withBorder key={streamer.username} data-testid="streamer-row">
          <Group justify="space-between">
            <Group>
              <ActionIcon
                variant="subtle" aria-label="Move up"
                onClick={() => moveUp(index)} disabled={index === 0}
              >
                ↑
              </ActionIcon>
              <Text fw={500}>{streamer.username}</Text>
            </Group>
            <Switch
              checked={streamer.enabled}
              onChange={() => toggle(index)}
              aria-label={`Enable ${streamer.username}`}
            />
          </Group>
        </Card>
      ))}
      <PendingBar count={changes} onApply={() => void apply()} busy={busy} />
    </Stack>
  );
}

function countChanges(before: StreamerEntry[], after: StreamerEntry[]): number {
  if (JSON.stringify(before) === JSON.stringify(after)) return 0;
  const names = new Set([...before, ...after].map((s) => s.username));
  let count = 0;
  for (const name of names) {
    const a = before.find((s) => s.username === name);
    const b = after.find((s) => s.username === name);
    if (JSON.stringify(a) !== JSON.stringify(b)) count += 1;
  }
  const orderChanged =
    before.map((s) => s.username).join() !== after.map((s) => s.username).join();
  return count === 0 && orderChanged ? 1 : count;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @app/frontend test Streamers`
Expected: PASS (8 tests)

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/routes/Streamers.tsx apps/frontend/src/components apps/frontend/src/routes/Streamers.test.tsx
git commit -m "feat: add streamers screen with staged changes and apply"
```

---

## Task 18: Live state hook and dashboard

**Files:**
- Create: `apps/frontend/src/api/useLiveState.ts`, `apps/frontend/src/routes/Dashboard.tsx`, `apps/frontend/src/components/StalenessBadge.tsx`
- Test: `apps/frontend/src/api/useLiveState.test.ts`, `apps/frontend/src/routes/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `api` (Task 16); `/api/streamers`, `/api/stream` (SSE)
- Produces: `useLiveState(): { snapshot: StateSnapshot | null; connected: boolean }`, `<Dashboard />`, `<StalenessBadge lastUpdated stale />`

- [ ] **Step 1: Write the failing staleness test**

`apps/frontend/src/routes/Dashboard.test.tsx`:
```tsx
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Dashboard } from "./Dashboard.js";

const snapshot = {
  lastUpdated: Date.now(),
  stale: false,
  error: null,
  streamers: [
    { username: "alpha", displayName: "Alpha", points: 123456, isOnline: true,
      channelId: "1", pointsEnabled: true },
    { username: "beta", displayName: "Beta", points: 20, isOnline: false,
      channelId: "2", pointsEnabled: true },
  ],
};

function stub(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
}

beforeEach(() => stub(snapshot));
afterEach(() => { vi.unstubAllGlobals(); });

const view = () => render(<MantineProvider><Dashboard /></MantineProvider>);

test("shows who is live", async () => {
  view();
  expect(await screen.findByTestId("live-alpha")).toBeInTheDocument();
  expect(screen.queryByTestId("live-beta")).not.toBeInTheDocument();
});

test("shows exact point totals, not abbreviated ones", async () => {
  view();
  expect(await screen.findByText("123,456")).toBeInTheDocument();
});

test("shows a total across streamers", async () => {
  view();
  expect(await screen.findByTestId("total-points")).toHaveTextContent("123,476");
});

test("marks the view stale rather than presenting old numbers as current", async () => {
  stub({ ...snapshot, stale: true, lastUpdated: Date.now() - 300_000 });
  view();
  expect(await screen.findByTestId("staleness")).toHaveTextContent(/stale/i);
});

test("surfaces a refresh error without hiding the last known numbers", async () => {
  stub({ ...snapshot, stale: true, error: "gql exploded" });
  view();
  expect(await screen.findByRole("alert")).toHaveTextContent("gql exploded");
  expect(screen.getByText("123,456")).toBeInTheDocument();
});

test("renders a streamer whose points could not be read as unknown, not zero", async () => {
  stub({ ...snapshot, streamers: [
    { username: "ghost", displayName: null, points: null, isOnline: null,
      channelId: null, pointsEnabled: null },
  ] });
  view();
  expect(await screen.findByText("—")).toBeInTheDocument();
});
```

- [ ] **Step 2: Write the failing live-state test**

`apps/frontend/src/api/useLiveState.test.ts`:
```ts
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useLiveState } from "./useLiveState.js";

const initial = { streamers: [], lastUpdated: 1, stale: false, error: null };

class FakeEventSource {
  static last: FakeEventSource | null = null;
  handlers = new Map<string, (e: MessageEvent) => void>();
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.handlers.set(type, fn);
  }
  emit(type: string, data: unknown) {
    this.handlers.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() {}
}

afterEach(() => { vi.unstubAllGlobals(); });

function setup() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => initial,
  })));
  vi.stubGlobal("EventSource", FakeEventSource);
  return renderHook(() => useLiveState());
}

test("seeds from the REST snapshot", async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.snapshot).toEqual(initial));
});

test("replaces the snapshot when a state event arrives", async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  const updated = { ...initial, lastUpdated: 2,
                    streamers: [{ username: "alpha", points: 5 }] };
  FakeEventSource.last!.emit("state", updated);
  await waitFor(() => expect(result.current.snapshot!.lastUpdated).toBe(2));
});

test("ignores a malformed frame instead of crashing", async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  FakeEventSource.last!.handlers.get("state")!({ data: "not json" } as MessageEvent);
  expect(result.current.snapshot).toEqual(initial);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @app/frontend test useLiveState Dashboard`
Expected: FAIL — cannot resolve `./useLiveState.js`

- [ ] **Step 4: Write the live-state hook**

`apps/frontend/src/api/useLiveState.ts`:
```ts
import { useEffect, useState } from "react";
import { api } from "./client.js";

export interface StreamerState {
  username: string;
  displayName: string | null;
  channelId: string | null;
  points: number | null;
  isOnline: boolean | null;
  pointsEnabled: boolean | null;
  error?: string;
}

export interface StateSnapshot {
  streamers: StreamerState[];
  lastUpdated: number | null;
  stale: boolean;
  error: string | null;
}

export function useLiveState() {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get<StateSnapshot>("/api/streamers")
      .then((s) => { if (alive) setSnapshot(s); })
      .catch(() => undefined);

    const source = new EventSource("/api/stream");
    source.addEventListener("state", (event) => {
      try {
        setSnapshot(JSON.parse((event as MessageEvent).data) as StateSnapshot);
        setConnected(true);
      } catch {
        // A malformed frame must never take the page down.
      }
    });
    return () => { alive = false; source.close(); };
  }, []);

  return { snapshot, connected };
}
```

- [ ] **Step 5: Write the staleness badge and dashboard**

`apps/frontend/src/components/StalenessBadge.tsx`:
```tsx
import { Badge } from "@mantine/core";

export function StalenessBadge({ lastUpdated, stale }: {
  lastUpdated: number | null; stale: boolean;
}) {
  if (lastUpdated === null) {
    return <Badge color="gray" data-testid="staleness">never updated</Badge>;
  }
  const seconds = Math.round((Date.now() - lastUpdated) / 1000);
  return (
    <Badge color={stale ? "orange" : "green"} data-testid="staleness">
      {stale ? `stale — updated ${seconds}s ago` : `updated ${seconds}s ago`}
    </Badge>
  );
}
```

`apps/frontend/src/routes/Dashboard.tsx`:
```tsx
import { Alert, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useLiveState } from "../api/useLiveState.js";
import { StalenessBadge } from "../components/StalenessBadge.js";

const nf = new Intl.NumberFormat("en-US");
const fmt = (points: number | null) => (points === null ? "—" : nf.format(points));

export function Dashboard() {
  const { snapshot } = useLiveState();
  if (!snapshot) return null;

  const total = snapshot.streamers.reduce((sum, s) => sum + (s.points ?? 0), 0);
  const live = snapshot.streamers.filter((s) => s.isOnline);

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Dashboard</Title>
        <StalenessBadge lastUpdated={snapshot.lastUpdated} stale={snapshot.stale} />
      </Group>

      {snapshot.error && <Alert role="alert" color="orange">{snapshot.error}</Alert>}

      <Card withBorder>
        <Text size="sm" c="dimmed">Total channel points</Text>
        <Text size="xl" fw={700} data-testid="total-points">{nf.format(total)}</Text>
      </Card>

      <Title order={4}>Live now ({live.length})</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {live.map((s) => (
          <Card withBorder key={s.username} data-testid={`live-${s.username}`}>
            <Text fw={600}>{s.displayName ?? s.username}</Text>
            <Text size="lg">{fmt(s.points)}</Text>
          </Card>
        ))}
      </SimpleGrid>

      <Title order={4}>All streamers</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {snapshot.streamers.map((s) => (
          <Card withBorder key={s.username}>
            <Group justify="space-between">
              <Text fw={500}>{s.displayName ?? s.username}</Text>
              <Text c={s.isOnline ? "green" : "dimmed"} size="sm">
                {s.isOnline === null ? "unknown" : s.isOnline ? "live" : "offline"}
              </Text>
            </Group>
            <Text size="lg">{fmt(s.points)}</Text>
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @app/frontend test useLiveState Dashboard`
Expected: PASS (9 tests)

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/api/useLiveState.ts apps/frontend/src/routes/Dashboard.tsx apps/frontend/src/components/StalenessBadge.tsx apps/frontend/src/api/useLiveState.test.ts apps/frontend/src/routes/Dashboard.test.tsx
git commit -m "feat: add live state hook and dashboard"
```

---

## Task 19: Login, settings and logs screens, and app shell

**Files:**
- Create: `apps/frontend/src/routes/Login.tsx`, `apps/frontend/src/routes/Settings.tsx`, `apps/frontend/src/routes/Logs.tsx`, `apps/frontend/src/app.tsx`, `apps/frontend/src/main.tsx`, `apps/frontend/index.html`
- Test: `apps/frontend/src/routes/Login.test.tsx`, `apps/frontend/src/routes/Settings.test.tsx`

**Interfaces:**
- Consumes: `api` (Task 16), `/api/status`, `/api/twitch/login`, `/api/logs`
- Produces: `<TwitchLogin />`, `<Settings />`, `<Logs />`, `<App />`

- [ ] **Step 1: Write the failing login test**

`apps/frontend/src/routes/Login.test.tsx`:
```tsx
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TwitchLogin } from "./Login.js";

function stub(status: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => status,
  })));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

const view = () => render(<MantineProvider><TwitchLogin /></MantineProvider>);

test("offers to start login when there is no session", async () => {
  stub({ login: null, miner: "STOPPED" });
  view();
  expect(await screen.findByRole("button", { name: /sign in to twitch/i })).toBeInTheDocument();
});

test("displays the device code and activation link", async () => {
  stub({ login: { stage: "code", userCode: "ABCD1234",
                  verificationUri: "https://www.twitch.tv/activate", expiresAt: 1 } });
  view();
  expect(await screen.findByText("ABCD1234")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /twitch.tv\/activate/i })).toHaveAttribute(
    "href", "https://www.twitch.tv/activate",
  );
});

test("shows waiting state while the code is pending", async () => {
  stub({ login: { stage: "pending" } });
  view();
  expect(await screen.findByText(/waiting/i)).toBeInTheDocument();
});

test("confirms a completed login", async () => {
  stub({ login: { stage: "ok", username: "alex" } });
  view();
  expect(await screen.findByText(/signed in as alex/i)).toBeInTheDocument();
});

test("surfaces a login error", async () => {
  stub({ login: { stage: "error", error: "code expired, start again" } });
  view();
  expect(await screen.findByRole("alert")).toHaveTextContent("code expired");
});

test("starting login posts to the API", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ login: null }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  view();
  await userEvent.click(await screen.findByRole("button", { name: /sign in to twitch/i }));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/twitch/login")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/frontend test Login`
Expected: FAIL — cannot resolve `./Login.js`

- [ ] **Step 3: Write the login screen**

`apps/frontend/src/routes/Login.tsx`:
```tsx
import { Alert, Anchor, Button, Card, Code, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

type Progress =
  | { stage: "code"; userCode: string; verificationUri: string; expiresAt: number }
  | { stage: "pending" }
  | { stage: "ok"; username: string }
  | { stage: "error"; error: string }
  | null;

export function TwitchLogin() {
  const [progress, setProgress] = useState<Progress>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.get<{ login: Progress }>("/api/status")
      .then((s) => setProgress(s.login))
      .finally(() => setLoaded(true));
    const source = new EventSource("/api/stream");
    source.addEventListener("login", (event) => {
      try {
        setProgress(JSON.parse((event as MessageEvent).data) as Progress);
      } catch {
        // ignore malformed frames
      }
    });
    return () => source.close();
  }, []);

  if (!loaded) return null;

  return (
    <Stack>
      <Title order={2}>Twitch account</Title>
      {progress?.stage === "error" && (
        <Alert role="alert" color="red">{progress.error}</Alert>
      )}
      {progress?.stage === "ok" && (
        <Text>Signed in as {progress.username}</Text>
      )}
      {progress?.stage === "pending" && <Text>Waiting for you to enter the code…</Text>}
      {progress?.stage === "code" && (
        <Card withBorder>
          <Stack>
            <Text>Open{" "}
              <Anchor href={progress.verificationUri} target="_blank" rel="noreferrer">
                {progress.verificationUri.replace("https://www.", "")}
              </Anchor>{" "}
              and enter this code:
            </Text>
            <Code fz="xl">{progress.userCode}</Code>
          </Stack>
        </Card>
      )}
      {(progress === null || progress.stage === "error" || progress.stage === "ok") && (
        <Button w={220} onClick={() => void api.post("/api/twitch/login")}>
          Sign in to Twitch
        </Button>
      )}
    </Stack>
  );
}
```

- [ ] **Step 4: Write the failing settings test**

`config.followers` and `config.followersOrder` are in the schema but no screen edits them yet. This closes that gap.

`apps/frontend/src/routes/Settings.test.tsx`:
```tsx
import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Settings } from "./Settings.js";

const config = {
  version: 1, username: "alex", followers: false, followersOrder: "ASC",
  defaults: {}, streamers: [],
};
let calls: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/config" && (!init || init.method === "GET")) {
      return { ok: true, status: 200, json: async () => config };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const view = () => render(<MantineProvider><Settings /></MantineProvider>);

test("shows the current followers setting", async () => {
  view();
  expect(await screen.findByLabelText(/mine my followed channels/i)).not.toBeChecked();
});

test("toggling followers stages a change rather than applying it", async () => {
  view();
  await userEvent.click(await screen.findByLabelText(/mine my followed channels/i));
  expect(await screen.findByTestId("pending-bar")).toBeInTheDocument();
  expect(calls.some((c) => c.url === "/api/config/apply")).toBe(false);
});

test("apply saves the new followers value and restarts", async () => {
  view();
  await userEvent.click(await screen.findByLabelText(/mine my followed channels/i));
  await userEvent.click(await screen.findByRole("button", { name: /apply & restart/i }));
  await waitFor(() => {
    const put = calls.find((c) => c.url === "/api/config" && c.init?.method === "PUT");
    expect(JSON.parse(String(put?.init?.body)).followers).toBe(true);
    expect(calls.some((c) => c.url === "/api/config/apply")).toBe(true);
  });
});

test("changing follower order stages a change", async () => {
  view();
  await screen.findByLabelText(/mine my followed channels/i);
  await userEvent.click(screen.getByLabelText(/newest first/i));
  expect(await screen.findByTestId("pending-bar")).toBeInTheDocument();
});
```

- [ ] **Step 5: Write the settings screen**

`apps/frontend/src/routes/Settings.tsx`:
```tsx
import { Alert, Radio, Stack, Switch, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { PendingBar } from "../components/PendingBar.js";

interface Config {
  version: 1; username: string; followers: boolean; followersOrder: string;
  defaults: Record<string, unknown>;
  streamers: Array<{ username: string; enabled: boolean; settings: Record<string, unknown> }>;
}

export function Settings() {
  const [saved, setSaved] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Config>("/api/config").then((c) => { setSaved(c); setDraft(c); });
  }, []);

  if (!draft || !saved) return null;

  const changed =
    draft.followers !== saved.followers ||
    draft.followersOrder !== saved.followersOrder;

  const apply = async () => {
    setBusy(true);
    try {
      await api.put("/api/config", draft);
      await api.post("/api/config/apply");
      setSaved(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack pb={80}>
      <Title order={2}>Settings</Title>
      {error && <Alert role="alert" color="red">{error}</Alert>}
      <Switch
        label="Mine my followed channels"
        description="Adds every channel you follow on Twitch to the mining list."
        checked={draft.followers}
        onChange={(e) => setDraft({ ...draft, followers: e.currentTarget.checked })}
      />
      <Radio.Group
        label="Follower order"
        value={draft.followersOrder}
        onChange={(value) => setDraft({ ...draft, followersOrder: value })}
      >
        <Stack gap="xs" mt="xs">
          <Radio value="ASC" label="Oldest first" />
          <Radio value="DESC" label="Newest first" />
        </Stack>
      </Radio.Group>
      <PendingBar count={changed ? 1 : 0} onApply={() => void apply()} busy={busy} />
    </Stack>
  );
}
```

- [ ] **Step 6: Run the settings test**

Run: `pnpm --filter @app/frontend test Settings`
Expected: PASS (4 tests)

- [ ] **Step 7: Write the logs screen and app shell**

`apps/frontend/src/routes/Logs.tsx`:
```tsx
import { Code, ScrollArea, Stack, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

export function Logs() {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    const load = () =>
      api.get<{ lines: string[] }>("/api/logs")
        .then((r) => setLines(r.lines))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Stack>
      <Title order={2}>Logs</Title>
      <ScrollArea h={600}>
        <Code block>{lines.join("\n")}</Code>
      </ScrollArea>
    </Stack>
  );
}
```

`apps/frontend/src/app.tsx`:
```tsx
import { AppShell, Badge, Group, NavLink, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "./api/client.js";
import { PasswordGate } from "./components/PasswordGate.js";
import { Dashboard } from "./routes/Dashboard.js";
import { TwitchLogin } from "./routes/Login.js";
import { Logs } from "./routes/Logs.js";
import { Settings } from "./routes/Settings.js";
import { Streamers } from "./routes/Streamers.js";

const SCREENS = {
  dashboard: { label: "Dashboard", element: <Dashboard /> },
  streamers: { label: "Streamers", element: <Streamers /> },
  logs: { label: "Logs", element: <Logs /> },
  settings: { label: "Settings", element: <Settings /> },
  account: { label: "Twitch account", element: <TwitchLogin /> },
} as const;

export function App() {
  const [screen, setScreen] = useState<keyof typeof SCREENS>("dashboard");
  const [minerState, setMinerState] = useState("…");

  useEffect(() => {
    const load = () =>
      api.get<{ miner: string }>("/api/status")
        .then((s) => setMinerState(s.miner))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <PasswordGate>
      <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: "sm" }} padding="md">
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between">
            <Title order={4}>Miner Control</Title>
            <Badge color={minerState === "RUNNING" ? "green" : "orange"}>{minerState}</Badge>
          </Group>
        </AppShell.Header>
        <AppShell.Navbar p="xs">
          {Object.entries(SCREENS).map(([key, { label }]) => (
            <NavLink
              key={key} label={label} active={screen === key}
              onClick={() => setScreen(key as keyof typeof SCREENS)}
            />
          ))}
        </AppShell.Navbar>
        <AppShell.Main>{SCREENS[screen].element}</AppShell.Main>
      </AppShell>
    </PasswordGate>
  );
}
```

`apps/frontend/src/main.tsx`:
```tsx
import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </StrictMode>,
);
```

`apps/frontend/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Miner Control</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @app/frontend test Login`
Expected: PASS (6 tests)

- [ ] **Step 9: Run the whole frontend suite and build**

Run: `pnpm --filter @app/frontend test && pnpm --filter @app/frontend build`
Expected: PASS, then a successful production build

- [ ] **Step 10: Commit**

```bash
git add apps/frontend
git commit -m "feat: add login, settings and logs screens with app shell"
```

---

## Task 20: Container packaging and end-to-end smoke test

**Files:**
- Create: `docker/Dockerfile`, `compose.yaml`, `.dockerignore`, `README.md`
- Modify: `apps/backend/src/http/server.ts` — serve the built frontend
- Test: `scripts/smoke.sh`

**Interfaces:**
- Consumes: everything
- Produces: a single runnable image

- [ ] **Step 1: Serve the frontend from the backend**

Add to `apps/backend/package.json` dependencies: `"@fastify/static": "^8.0.0"`.

In `apps/backend/src/http/server.ts`, inside `buildServer`, after the `app.register(async (instance) => {...})` block, add:

```ts
  if (deps.staticRoot) {
    void app.register(fastifyStatic, { root: deps.staticRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/internal/")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }
```

Add `import fastifyStatic from "@fastify/static";` at the top and `staticRoot?: string;` to `ServerDeps`. In `apps/backend/src/index.ts`, pass `staticRoot: resolve(process.env.STATIC_ROOT ?? "./public")`.

- [ ] **Step 2: Add a test for the SPA fallback**

Append to `apps/backend/src/http/server.test.ts`:
```ts
test("unknown API paths 404 as JSON rather than falling back to the SPA", async () => {
  const res = await ctx.app.inject({
    method: "GET", url: "/api/nonexistent", cookies: auth(),
  });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "not found" });
});
```

Run: `pnpm --filter @app/backend test server`
Expected: PASS

- [ ] **Step 3: Write the Dockerfile**

`docker/Dockerfile`:
```dockerfile
FROM node:22-slim AS web
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build

FROM python:3.12-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml uv.lock ./
COPY vendor/miner vendor/miner
RUN uv sync --frozen --no-dev

COPY python python
COPY --from=web /build/apps/backend/dist apps/backend/dist
COPY --from=web /build/apps/backend/node_modules apps/backend/node_modules
COPY --from=web /build/apps/frontend/dist public

ENV DATA_DIR=/data \
    PYTHON_DIR=/app/python \
    PYTHON_BIN=/app/.venv/bin/python \
    STATIC_ROOT=/app/public \
    PORT=8080
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "apps/backend/dist/index.js"]
```

- [ ] **Step 4: Write the compose file**

`compose.yaml`:
```yaml
services:
  miner-ui:
    build:
      context: .
      dockerfile: docker/Dockerfile
    init: true            # reap orphaned Python children
    ports:
      - "8080:8080"
    environment:
      APP_PASSWORD: ${APP_PASSWORD:?set APP_PASSWORD in .env}
    volumes:
      - ./data:/data
    restart: unless-stopped
```

`.dockerignore`:
```
node_modules
**/node_modules
**/dist
data
.git
```

- [ ] **Step 5: Write the smoke script**

`scripts/smoke.sh`:
```bash
#!/usr/bin/env bash
# End-to-end smoke test: build, boot, and confirm the API answers.
set -euo pipefail

export APP_PASSWORD="${APP_PASSWORD:-smoke-test-password}"
docker compose build
docker compose up -d

cleanup() { docker compose down -v; }
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl -sf -o /dev/null http://localhost:8080/; then break; fi
  sleep 2
done

echo "--- unauthenticated request must be rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/status)
test "$code" = "401" || { echo "expected 401, got $code"; exit 1; }

echo "--- login and read status"
curl -sf -c /tmp/smoke-cookies -H 'Content-Type: application/json' \
  -d "{\"password\":\"$APP_PASSWORD\"}" http://localhost:8080/api/session > /dev/null
curl -sf -b /tmp/smoke-cookies http://localhost:8080/api/status | grep -q '"miner"'

echo "--- frontend is served"
curl -sf http://localhost:8080/ | grep -q '<div id="root">'

echo "SMOKE OK"
```

Make it executable: `chmod +x scripts/smoke.sh`

- [ ] **Step 6: Run the smoke test**

Run: `./scripts/smoke.sh`
Expected: prints `SMOKE OK`. The miner itself will sit in `LOGIN_REQUIRED` because no Twitch account is configured — that is the correct first-boot state.

- [ ] **Step 7: Write the README**

`README.md`:
```markdown
# Twitch Miner Control UI

Web UI to configure and control
[mpforce1/Twitch-Channel-Points-Miner](https://github.com/mpforce1/Twitch-Channel-Points-Miner).

## Quick start

    git clone --recurse-submodules <this repo>
    echo "APP_PASSWORD=choose-something" > .env
    docker compose up -d

Open http://localhost:8080, unlock with your password, then go to
**Twitch account** and sign in with the device code. Add streamers on the
**Streamers** screen and press **Apply & Restart**.

## Design

- `docs/superpowers/specs/2026-08-29-twitch-miner-web-ui-design.md`
- `docs/superpowers/plans/2026-08-29-twitch-miner-web-ui.md`

## Updating the miner

    git -C vendor/miner pull
    uv run pytest python/tests/test_contract.py

If the contract test fails, the upstream API we depend on has changed. Read
the spec's "Key findings from upstream source" before adapting.

## Not supported

LAN use only — there is no TLS, no per-user accounts, and no rate limiting.
Do not expose this to the internet.
```

- [ ] **Step 8: Run the full suite and commit**

```bash
pnpm test && uv run pytest
git add -A
git commit -m "feat: add container packaging and end-to-end smoke test"
```
