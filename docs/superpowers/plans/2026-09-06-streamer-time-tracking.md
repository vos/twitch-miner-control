# Streamer Time Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-streamer online duration, last mining activity, 24h online/mining time, all-time mining time and points-per-hour on the dashboard cards.

**Architecture:** Twitch's `WithIsStreamLiveQuery` already returns the current stream's `id` and `createdAt` on every poll and we discard both; we start using them for "now". Two new SQLite span tables (`streamer_sessions`, `miner_sessions`) record history, which Twitch cannot answer. Mining time is the *intersection* of a streamer's online spans with the miner's uptime spans, so a stopped miner cannot inflate the figures.

**Tech Stack:** TypeScript (backend, Node + better-sqlite3), Vitest, React + Mantine (frontend), Python 3 (miner helpers), pytest.

**Spec:** `docs/superpowers/specs/2026-09-06-streamer-time-tracking-design.md`

## Global Constraints

- **Package manager is pnpm.** Never `npm`. Backend tests: `pnpm --filter @app/backend test`. Frontend: `pnpm --filter @app/frontend test`. Python: `uv run pytest`.
- **ESM imports need the `.js` extension**, even from `.ts` files (`import { History } from "../db/history.js"`). Omitting it breaks the build.
- **Timestamps are epoch milliseconds** everywhere they cross a boundary. Never a `datetime`, never seconds.
- **Durations reaching `StreamerState` are quantized**: `online24h`/`mined24h`/`minedTotal` to the nearest minute, `pointsPerHour` to one decimal. Unrounded values change every tick and would make every SSE frame a broadcast to every client.
- **Never parse numbers out of miner log messages.** Balances in them are millified ("12.3k") and lossy. Matching a message against a known roster login is allowed; extracting values is not.
- **This is a prototype:** the schema may change freely, no back-compat, no data migration beyond the additive column guard. Commit straight to `main`, no feature branches.
- **Test style:** flat `test("...", () => {})` from Vitest, no `describe` blocks. `new History(openDb(":memory:"))` for DB tests.

---

### Task 1: Return the stream's identity and start time from Python

The whole plan depends on this: every later task consumes `streamId`/`streamStartedAt`.

**Files:**
- Modify: `python/helpers/state.py` (`Handler._one`, ~line 200)
- Test: `python/tests/test_state.py`, `python/tests/test_contract.py`

**Interfaces:**
- Produces: `_one()` result gains `"streamId": str | None` and `"streamStartedAt": int | None` (epoch ms).

- [ ] **Step 1: Write the failing test**

Add to `python/tests/test_state.py`. Match the existing fake-session style in that file — read the top of it first and reuse its fakes rather than inventing new ones.

```python
def test_one_reports_stream_identity_and_start(monkeypatch):
    """The live query already carries the stream's id and createdAt."""
    import datetime
    handler = _handler_with_stream(
        stream_id="STREAM-1",
        created_at=datetime.datetime(2026, 9, 6, 8, 15, tzinfo=datetime.timezone.utc),
    )
    out = handler._one("alpha")
    assert out["streamId"] == "STREAM-1"
    assert out["streamStartedAt"] == 1788682500000
    assert out["isOnline"] is True


def test_one_reports_nulls_when_offline():
    handler = _handler_with_stream(stream=None)
    out = handler._one("alpha")
    assert out["streamId"] is None
    assert out["streamStartedAt"] is None
    assert out["isOnline"] is False
```

Write `_handler_with_stream` as a helper in the test file, building the same fake session shape the neighbouring tests use, where `gql.with_is_stream_live_query` returns an object whose `.user.stream` is either `None` or an object with `.id` and `.created_at`.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest python/tests/test_state.py -k stream -v`
Expected: FAIL with `KeyError: 'streamId'`

- [ ] **Step 3: Write minimal implementation**

In `_one`, replace the `return` block's `isOnline` line. The existing code ends:

```python
        live = self.session.gql.with_is_stream_live_query(channel.id)
        return {
            ...
            "isOnline": live.user.stream is not None,
```

Change to:

```python
        live = self.session.gql.with_is_stream_live_query(channel.id)
        stream = live.user.stream
        return {
            "username": username,
            "channelId": channel.id,
            "displayName": community.display_name,
            "points": channel.edge.community_points.balance,
            "isOnline": stream is not None,
            "pointsEnabled": channel.community_points_settings.is_enabled,
            # Twitch's own stream identity and start time, which the live
            # query already returns and we used to reduce to a boolean.
            # `created_at` is a timezone-aware datetime (upstream parses
            # the Z-suffixed UTC string with expect_iso_8601), so
            # .timestamp() is unambiguous -- but datetime is not JSON
            # serialisable and would raise when serve() writes the NDJSON
            # response, so it is converted to epoch ms here.
            "streamId": stream.id if stream is not None else None,
            "streamStartedAt": (
                int(stream.created_at.timestamp() * 1000)
                if stream is not None
                else None
            ),
        }
```

Also update the early `community is None` return in the same method to include `"streamId": None, "streamStartedAt": None`, so every path returns the same keys.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest python/tests/test_state.py -v`
Expected: PASS

- [ ] **Step 5: Pin the upstream field with a contract test**

Add to `python/tests/test_contract.py`, near the other GQL assertions:

```python
def test_stream_response_exposes_id_and_created_at():
    """We depend on these two fields in helpers/state.py:_one().

    If this fails after bumping vendor/miner, the live query's response
    shape changed and the streamer cards' uptime figures are affected.
    """
    from TwitchChannelPointsMiner.classes.gql.data.response.WithIsStreamLiveQuery import (
        Stream,
    )
    assert params(Stream.__init__) == ["self", "_id", "created_at"]
```

- [ ] **Step 6: Run the full Python suite**

Run: `uv run pytest`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add python/helpers/state.py python/tests/test_state.py python/tests/test_contract.py
git commit -m "feat: report the stream's id and start time from the state helper

The live query already returns both and we reduced it to a boolean.
Twitch's own createdAt beats deriving uptime from observed transitions:
it is correct the first time we look at a stream already in progress.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Span arithmetic (`spans.ts`)

Pure functions, no I/O. Every displayed duration is downstream of these, so they carry the most risk and get the most tests.

**Files:**
- Create: `apps/backend/src/state/spans.ts`
- Test: `apps/backend/src/state/spans.test.ts`

**Interfaces:**
- Produces:
  - `export interface Span { start: number; end: number | null }`
  - `export function clip(spans: Span[], from: number, to: number): Span[]`
  - `export function intersect(a: Span[], b: Span[]): Span[]`
  - `export function total(spans: Span[]): number`

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/state/spans.test.ts`:

```typescript
import { expect, test } from "vitest";
import { clip, intersect, total } from "./spans.js";

test("clips a span to the window", () => {
  expect(clip([{ start: 0, end: 100 }], 25, 75)).toEqual([{ start: 25, end: 75 }]);
});

test("drops spans entirely outside the window", () => {
  expect(clip([{ start: 0, end: 10 }], 50, 100)).toEqual([]);
});

test("keeps a span that spans the whole window", () => {
  expect(clip([{ start: 0, end: 1000 }], 100, 200)).toEqual([{ start: 100, end: 200 }]);
});

test("treats an open span as ending at the window end", () => {
  // `end: null` means "still running". The window's end is the caller's
  // "now", so an open span is clipped to it rather than to Infinity.
  expect(clip([{ start: 50, end: null }], 0, 100)).toEqual([{ start: 50, end: 100 }]);
});

test("drops zero-length spans", () => {
  // A span that starts and ends at the same instant contributes nothing
  // and would otherwise survive as noise in the output.
  expect(clip([{ start: 50, end: 50 }], 0, 100)).toEqual([]);
});

test("intersects overlapping spans", () => {
  expect(intersect(
    [{ start: 0, end: 100 }],
    [{ start: 50, end: 150 }],
  )).toEqual([{ start: 50, end: 100 }]);
});

test("intersects one span against many", () => {
  expect(intersect(
    [{ start: 0, end: 100 }],
    [{ start: 10, end: 20 }, { start: 30, end: 40 }],
  )).toEqual([{ start: 10, end: 20 }, { start: 30, end: 40 }]);
});

test("returns nothing when spans do not overlap", () => {
  expect(intersect([{ start: 0, end: 10 }], [{ start: 20, end: 30 }])).toEqual([]);
});

test("returns nothing when either side is empty", () => {
  // The miner never ran, so no online time can count as mined.
  expect(intersect([{ start: 0, end: 10 }], [])).toEqual([]);
  expect(intersect([], [{ start: 0, end: 10 }])).toEqual([]);
});

test("treats adjacent spans as non-overlapping", () => {
  // Touching at a single instant is not overlap: the miner started the
  // moment the stream ended, which is zero mining time, not a boundary
  // to be rounded up.
  expect(intersect([{ start: 0, end: 50 }], [{ start: 50, end: 100 }])).toEqual([]);
});

test("sums spans", () => {
  expect(total([{ start: 0, end: 50 }, { start: 100, end: 125 }])).toBe(75);
});

test("sums nothing to zero", () => {
  expect(total([])).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test spans`
Expected: FAIL — cannot resolve `./spans.js`

- [ ] **Step 3: Write the implementation**

Create `apps/backend/src/state/spans.ts`:

```typescript
/**
 * Interval arithmetic for the time-tracking figures.
 *
 * A span with `end: null` is still running. Nothing here writes an end
 * time: an open span is *read* as ending at the caller's window end, so
 * the same row keeps growing until whatever owns it closes it. Writing
 * "now" into the table would turn a live fact into a stale one the
 * moment the process died.
 */
export interface Span {
  start: number;
  end: number | null;
}

/**
 * Restricts spans to `[from, to]`, resolving open spans against `to`.
 *
 * Zero-length results are dropped rather than kept: they contribute
 * nothing to any total, and letting them through means every consumer
 * has to filter them again.
 */
export function clip(spans: Span[], from: number, to: number): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const start = Math.max(span.start, from);
    const end = Math.min(span.end ?? to, to);
    if (end > start) out.push({ start, end });
  }
  return out;
}

/**
 * The overlap between two sets of spans -- "online AND mining".
 *
 * O(n*m) by design. Both inputs are bounded by a day of streams and miner
 * restarts, so a sweep-line's bookkeeping would cost more to read than
 * the loop saves to run.
 *
 * Adjacency is not overlap: spans touching at one instant produce
 * nothing, since `end > start` fails.
 */
export function intersect(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const left of a) {
    for (const right of b) {
      const start = Math.max(left.start, right.start);
      // An open span on either side extends to the other's end; when both
      // are open the overlap is open too, and Infinity lets the caller's
      // clip() resolve it against a real window.
      const end = Math.min(left.end ?? Infinity, right.end ?? Infinity);
      if (end > start) out.push({ start, end });
    }
  }
  return out;
}

/** Total milliseconds covered. Open spans count as zero -- clip() first. */
export function total(spans: Span[]): number {
  return spans.reduce((sum, s) => sum + ((s.end ?? s.start) - s.start), 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test spans`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/state/spans.ts apps/backend/src/state/spans.test.ts
git commit -m "feat: span clipping and intersection for time tracking

Mining time is online time intersected with miner uptime, so a stopped
miner cannot inflate it. Pure functions: every displayed duration is
downstream of these.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Schema — span tables and the `events.streamer` column

**Files:**
- Modify: `apps/backend/src/db/schema.ts`
- Test: `apps/backend/src/db/schema.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `streamer_sessions`, `miner_sessions`; column `events.streamer`.

- [ ] **Step 1: Write the failing test**

Create/extend `apps/backend/src/db/schema.test.ts`:

```typescript
import { expect, test } from "vitest";
import Database from "better-sqlite3";
import { openDb } from "./schema.js";

const columns = (db: ReturnType<typeof openDb>, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name);

test("creates the span tables", () => {
  const db = openDb(":memory:");
  expect(columns(db, "streamer_sessions")).toEqual(
    expect.arrayContaining(["streamer", "stream_id", "start_ts", "end_ts", "anchor_points"]),
  );
  expect(columns(db, "miner_sessions")).toEqual(
    expect.arrayContaining(["start_ts", "end_ts", "heartbeat"]),
  );
});

test("one row per real stream", () => {
  const db = openDb(":memory:");
  const insert = () => db.prepare(
    "INSERT INTO streamer_sessions (streamer, stream_id, start_ts) VALUES (?, ?, ?)",
  ).run("alpha", "S1", 1000);
  insert();
  // A restart mid-stream must not open a second row for the same stream.
  expect(insert).toThrow(/UNIQUE/);
});

test("adds events.streamer to a database created before the column existed", () => {
  // Simulates an existing install: build the old two-column shape, then
  // let openDb() migrate it. CREATE TABLE IF NOT EXISTS is a no-op
  // against an existing table, so without the guard every insert naming
  // `streamer` would fail.
  const file = `/tmp/schema-migration-${process.pid}.db`;
  const old = new Database(file);
  old.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, message TEXT)");
  old.close();

  const db = openDb(file);
  expect(columns(db, "events")).toContain("streamer");
  db.close();
  require("fs").rmSync(file, { force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/backend test schema`
Expected: FAIL — `no such table: streamer_sessions`

- [ ] **Step 3: Write the implementation**

In `apps/backend/src/db/schema.ts`, add to the `db.exec()` block:

```sql
    CREATE TABLE IF NOT EXISTS streamer_sessions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      streamer  TEXT    NOT NULL,
      -- Twitch's stream id: the row's identity. One row per real stream,
      -- however many times we restart while it runs.
      stream_id TEXT    NOT NULL,
      -- Twitch's own createdAt, not when our poller first looked, so a
      -- stream we joined late is still recorded with its true start.
      start_ts  INTEGER NOT NULL,
      end_ts    INTEGER,
      -- Balance at our first sighting of this stream: the gainedStream
      -- anchor, persisted so a restart cannot reset it to zero.
      anchor_points INTEGER,
      UNIQUE (streamer, stream_id)
    );
    CREATE INDEX IF NOT EXISTS idx_streamer_sessions_lookup
      ON streamer_sessions (streamer, start_ts);

    CREATE TABLE IF NOT EXISTS miner_sessions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      start_ts  INTEGER NOT NULL,
      end_ts    INTEGER,
      -- Refreshed every poll tick while RUNNING, so a hard kill leaves a
      -- last-known-good timestamp to close the row at on the next boot.
      heartbeat INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_miner_sessions_start ON miner_sessions (start_ts);
```

Then rename the existing migration helper to cover both columns. Replace `addEventMessageColumn(db)` with `addEventColumns(db)` and the function itself:

```typescript
/**
 * Adds columns to an `events` table created before they existed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so a
 * database from an earlier run keeps its original shape and every insert
 * naming a new column would fail. Guarded by a table_info scan because
 * SQLite has no `ADD COLUMN IF NOT EXISTS`.
 */
function addEventColumns(db: Db): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(events)").all() as { name: string }[])
      .map((column) => column.name),
  );
  if (!existing.has("message")) db.exec("ALTER TABLE events ADD COLUMN message TEXT");
  // Attributed from the roster at write time; NULL when no streamer in
  // the message could be identified.
  if (!existing.has("streamer")) db.exec("ALTER TABLE events ADD COLUMN streamer TEXT");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test`
Expected: PASS (whole backend suite — `history.test.ts` also touches this schema)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/db/schema.ts apps/backend/src/db/schema.test.ts
git commit -m "feat: span tables and events.streamer column

streamer_sessions is keyed on Twitch's stream id so a restart mid-stream
continues the same row rather than opening a second.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: History methods for spans

**Files:**
- Modify: `apps/backend/src/db/history.ts`
- Test: `apps/backend/src/db/history.test.ts`

**Interfaces:**
- Consumes: `Span` from `../state/spans.js`.
- Produces on `History`:
  - `openStreamerSession(streamer: string, streamId: string, startTs: number, anchorPoints: number | null): void`
  - `closeStreamerSessionsExcept(streamer: string, liveStreamId: string | null, endTs: number): void`
  - `streamerSpans(streamer: string, fromTs?: number): Span[]`
  - `streamAnchor(streamer: string, streamId: string): number | null`
  - `lastLive(streamer: string): number | null`
  - `openMinerSession(startTs: number): void`
  - `beatMinerSession(ts: number): void`
  - `closeMinerSession(endTs: number): void`
  - `minerSpans(fromTs?: number): Span[]`
  - `recoverOpenSessions(): void`

- [ ] **Step 1: Write the failing tests**

Add to `apps/backend/src/db/history.test.ts`:

```typescript
test("opens one session per stream and ignores repeat sightings", () => {
  history.openStreamerSession("alpha", "S1", 1000, 500);
  history.openStreamerSession("alpha", "S1", 1000, 900);
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: null }]);
  // The anchor is the FIRST sighting's balance; a later tick must not
  // move it, or the per-stream gain would reset to zero every poll.
  expect(history.streamAnchor("alpha", "S1")).toBe(500);
});

test("records a stream joined late with its true start", () => {
  // We first looked at 9000, but Twitch says the stream began at 1000.
  history.openStreamerSession("alpha", "S1", 1000, 500);
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: null }]);
});

test("closes sessions other than the live one", () => {
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.closeStreamerSessionsExcept("alpha", null, 5000);
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: 5000 }]);
});

test("leaves the live session open", () => {
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.closeStreamerSessionsExcept("alpha", "S1", 5000);
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: null }]);
});

test("reports when a streamer was last live", () => {
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.closeStreamerSessionsExcept("alpha", null, 5000);
  expect(history.lastLive("alpha")).toBe(5000);
});

test("reports no last-live for a streamer still live", () => {
  history.openStreamerSession("alpha", "S1", 1000, 0);
  expect(history.lastLive("alpha")).toBeNull();
});

test("tracks miner sessions with a heartbeat", () => {
  history.openMinerSession(1000);
  history.beatMinerSession(2000);
  history.closeMinerSession(3000);
  expect(history.minerSpans()).toEqual([{ start: 1000, end: 3000 }]);
});

test("closes a killed miner session at its heartbeat, not at boot", () => {
  // The process died after the 2000 heartbeat; boot happens much later.
  // Closing at boot would invent hours of mining that never happened.
  history.openMinerSession(1000);
  history.beatMinerSession(2000);
  history.recoverOpenSessions();
  expect(history.minerSpans()).toEqual([{ start: 1000, end: 2000 }]);
});

test("closes a stream that ended during downtime at our last evidence", () => {
  // We recorded points up to 4000, then died. The stream is not live on
  // the next boot, so it must close where our evidence stops -- not at
  // the post-boot poll, which would count the whole outage as online.
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.recordPoints("alpha", 10, 4000);
  history.closeStreamerSessionsExcept("alpha", null, 99_000);
  expect(history.streamerSpans("alpha")).toEqual([{ start: 1000, end: 4000 }]);
});

test("closes a stream with no snapshots at its start", () => {
  // No evidence we ever watched it. The row closes at its own start, so
  // it survives as a zero-length span rather than staying open forever
  // claiming the channel is still live. clip() drops it from every
  // total, so it contributes nothing without needing a special case.
  history.openStreamerSession("beta", "S9", 1000, 0);
  history.closeStreamerSessionsExcept("beta", null, 99_000);
  expect(history.streamerSpans("beta")).toEqual([{ start: 1000, end: 1000 }]);
});
```

The `MAX(start_ts, ...)` in the implementation below is what produces
that zero-length row: a clamp that would otherwise write an `end_ts`
*before* the start (no snapshots at all, or only ones predating the
stream) is floored at the start instead, which is the only value that
cannot invent time. `clip()` then discards it, since it requires
`end > start`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test history`
Expected: FAIL — `history.openStreamerSession is not a function`

- [ ] **Step 3: Write the implementation**

Add to `apps/backend/src/db/history.ts` (import `Span` at the top: `import type { Span } from "../state/spans.js";`):

```typescript
  /**
   * Records the first sighting of a stream. Idempotent per stream.
   *
   * `ON CONFLICT DO NOTHING` is what makes this restart-proof: this is
   * called on every tick a streamer is live, not on an observed
   * transition, so the second and thousandth sighting of the same stream
   * must leave the row -- and crucially its anchor balance -- untouched.
   */
  openStreamerSession(
    streamer: string,
    streamId: string,
    startTs: number,
    anchorPoints: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO streamer_sessions (streamer, stream_id, start_ts, anchor_points)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (streamer, stream_id) DO NOTHING`,
      )
      .run(streamer, streamId, startTs, anchorPoints);
  }

  /**
   * Closes every open session for a streamer except the one still live.
   *
   * The end time is clamped to the streamer's last point snapshot: if the
   * backend was down when the stream ended, `endTs` is the first
   * post-boot poll and using it directly would bill the entire outage as
   * online time. The last snapshot is the last moment we were
   * demonstrably watching.
   */
  closeStreamerSessionsExcept(
    streamer: string,
    liveStreamId: string | null,
    endTs: number,
  ): void {
    const last = this.db
      .prepare("SELECT MAX(ts) AS ts FROM point_snapshots WHERE streamer = ?")
      .get(streamer) as { ts: number | null };
    const evidence = last.ts === null ? null : Math.min(endTs, last.ts);
    this.db
      .prepare(
        `UPDATE streamer_sessions
            SET end_ts = MAX(start_ts, COALESCE(?, start_ts))
          WHERE streamer = ? AND end_ts IS NULL
            AND (? IS NULL OR stream_id != ?)`,
      )
      .run(evidence, streamer, liveStreamId, liveStreamId);
  }

  streamerSpans(streamer: string, fromTs = 0): Span[] {
    return this.db
      .prepare(
        `SELECT start_ts AS start, end_ts AS end FROM streamer_sessions
          WHERE streamer = ? AND (end_ts IS NULL OR end_ts >= ?)
          ORDER BY start_ts ASC`,
      )
      .all(streamer, fromTs) as Span[];
  }

  streamAnchor(streamer: string, streamId: string): number | null {
    const row = this.db
      .prepare(
        "SELECT anchor_points FROM streamer_sessions WHERE streamer = ? AND stream_id = ?",
      )
      .get(streamer, streamId) as { anchor_points: number | null } | undefined;
    return row?.anchor_points ?? null;
  }

  /** When this streamer was last live, or null if live now or never seen. */
  lastLive(streamer: string): number | null {
    const open = this.db
      .prepare(
        "SELECT 1 FROM streamer_sessions WHERE streamer = ? AND end_ts IS NULL LIMIT 1",
      )
      .get(streamer);
    if (open) return null;
    const row = this.db
      .prepare("SELECT MAX(end_ts) AS ts FROM streamer_sessions WHERE streamer = ?")
      .get(streamer) as { ts: number | null };
    return row.ts;
  }

  openMinerSession(startTs: number): void {
    this.db
      .prepare("INSERT INTO miner_sessions (start_ts, heartbeat) VALUES (?, ?)")
      .run(startTs, startTs);
  }

  /** Marks the open miner session alive; the recovery point after a kill. */
  beatMinerSession(ts: number): void {
    this.db
      .prepare("UPDATE miner_sessions SET heartbeat = ? WHERE end_ts IS NULL")
      .run(ts);
  }

  closeMinerSession(endTs: number): void {
    this.db
      .prepare("UPDATE miner_sessions SET end_ts = ? WHERE end_ts IS NULL")
      .run(endTs);
  }

  minerSpans(fromTs = 0): Span[] {
    return this.db
      .prepare(
        `SELECT start_ts AS start, end_ts AS end FROM miner_sessions
          WHERE end_ts IS NULL OR end_ts >= ?
          ORDER BY start_ts ASC`,
      )
      .all(fromTs) as Span[];
  }

  /**
   * Closes miner sessions left open by a killed process.
   *
   * Called once on boot, before anything reads a span. An open row is a
   * claim the miner is still running; after a SIGKILL that claim grows
   * unattended, so an 8-hour-old row would silently become 8 hours of
   * mining that never happened. The heartbeat is the last moment we know
   * it was actually up.
   *
   * Streamer sessions need no equivalent: they are keyed on Twitch's
   * stream id, so the first post-boot poll either matches the row (still
   * live, keep it open) or does not (closed by
   * closeStreamerSessionsExcept, clamped to our last evidence).
   */
  recoverOpenSessions(): void {
    this.db.exec("UPDATE miner_sessions SET end_ts = heartbeat WHERE end_ts IS NULL");
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test history`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/db/history.ts apps/backend/src/db/history.test.ts
git commit -m "feat: span persistence and crash recovery

Streamer sessions are an upsert on Twitch's stream id, so repeat
sightings never move the anchor. Miner sessions close at their heartbeat
on boot, never at boot time.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Supervisor writes miner sessions

**Files:**
- Modify: `apps/backend/src/miner/supervisor.ts`, `apps/backend/src/index.ts`
- Test: `apps/backend/src/miner/supervisor.test.ts`

**Interfaces:**
- Consumes: `History.openMinerSession`, `closeMinerSession` (Task 4).
- Produces: `SupervisorOptions.sessions?: { open(ts: number): void; close(ts: number): void }`

The supervisor takes a narrow `sessions` port rather than the whole `History`: it needs two methods, and a small interface keeps its tests free of a database.

- [ ] **Step 1: Write the failing test**

Add to `apps/backend/src/miner/supervisor.test.ts`, following that file's existing setup for spawning a fake child:

```typescript
test("records a miner session while running", async () => {
  const open = vi.fn();
  const close = vi.fn();
  // Reuse this file's existing helper for building a Supervisor with a
  // fake spawn; add `sessions: { open, close }` to its options.
  const supervisor = makeSupervisor({ sessions: { open, close } });

  await supervisor.start();
  expect(open).toHaveBeenCalledOnce();

  await supervisor.stop();
  expect(close).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/backend test supervisor`
Expected: FAIL — `open` not called

- [ ] **Step 3: Write the implementation**

Add to `SupervisorOptions`:

```typescript
  /**
   * Records miner uptime spans, so mining time can be distinguished from
   * a channel merely being live. A narrow port rather than the History
   * itself: two methods is all this needs, and the supervisor's tests
   * stay free of a database.
   */
  sessions?: { open(ts: number): void; close(ts: number): void };
```

In `setState`, after the existing guard and assignment, record the transition. Read the surrounding method before editing — the guard that returns early when the state is unchanged is what keeps this from double-writing:

```typescript
  private setState(state: MinerState): void {
    if (this.state === state) return;
    const was = this.state;
    this.state = state;
    // RUNNING is the only state where the miner is actually mining, so
    // the span opens on entry and closes on every exit -- including a
    // crash, where the process is gone but the row must not stay open.
    if (state === "RUNNING") this.options.sessions?.open(Date.now());
    else if (was === "RUNNING") this.options.sessions?.close(Date.now());
    this.emit("state", state);
  }
```

(Adjust `this.options` to whatever the constructor stores options as — check the top of the class.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test supervisor`
Expected: PASS

- [ ] **Step 5: Wire it in `index.ts`**

In the `new Supervisor({...})` call (~line 89), add — noting `history` is declared *after* the supervisor today, so move the `openDb`/`History` lines above it:

```typescript
  sessions: {
    open: (ts) => history.openMinerSession(ts),
    close: (ts) => history.closeMinerSession(ts),
  },
```

And immediately after `const history = new History(db);`, add:

```typescript
// Close spans left open by a killed process before anything reads one.
history.recoverOpenSessions();
```

- [ ] **Step 6: Verify the build and full suite**

Run: `pnpm run build:backend && pnpm --filter @app/backend test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/miner/supervisor.ts apps/backend/src/miner/supervisor.test.ts apps/backend/src/index.ts
git commit -m "feat: record miner uptime spans

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Event attribution to a streamer

**Files:**
- Create: `apps/backend/src/state/attribute.ts`, `apps/backend/src/state/attribute.test.ts`
- Modify: `apps/backend/src/db/history.ts`, `apps/backend/src/state/service.ts`

**Interfaces:**
- Produces: `export function attribute(message: string | null, roster: string[]): string | null`
- Modifies: `History.recordEvent(type, ts, message, streamer?)`; adds `History.lastActivity(streamer): { ts: number; type: string } | null`

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/state/attribute.test.ts`:

```typescript
import { expect, test } from "vitest";
import { attribute } from "./attribute.js";

test("attributes a message naming one roster streamer", () => {
  expect(attribute("+50 -> forsen", ["forsen", "alpha"])).toBe("forsen");
});

test("matches case-insensitively", () => {
  expect(attribute("+50 -> Forsen", ["forsen"])).toBe("forsen");
});

test("returns null when no roster streamer is named", () => {
  expect(attribute("+50 -> someone_else", ["forsen"])).toBeNull();
});

test("returns null for a message naming two roster streamers", () => {
  // A raid line names both channels. Attributing it to whichever matched
  // first would be a guess, and a wrong guess here silently misreports
  // another streamer's last activity.
  expect(attribute("forsen raided alpha", ["forsen", "alpha"])).toBeNull();
});

test("requires a word boundary", () => {
  // "alpha" must not match inside "alphabet", or a streamer with a short
  // login would be attributed half the feed.
  expect(attribute("alphabet soup", ["alpha"])).toBeNull();
});

test("returns null for a null message", () => {
  expect(attribute(null, ["alpha"])).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test attribute`
Expected: FAIL — cannot resolve `./attribute.js`

- [ ] **Step 3: Write the implementation**

Create `apps/backend/src/state/attribute.ts`:

```typescript
/**
 * Identifies which roster streamer a miner log line is about.
 *
 * The `events` table is global -- the doorbell reports the miner's own
 * formatted message, in which the streamer's name is the only per-channel
 * detail that survives. This matches that message against the *known*
 * roster, which is a different operation from parsing the message: the
 * candidate set is closed, so a hit is an identification rather than an
 * interpretation. Balances inside the message stay untouched; they are
 * millified and lossy (see python/helpers/doorbell.py).
 *
 * An ambiguous message -- a raid line names two channels -- returns null.
 * Picking the first match would be a guess, and a wrong guess puts one
 * streamer's activity on another's card.
 */
export function attribute(message: string | null, roster: string[]): string | null {
  if (!message) return null;
  const lowered = message.toLowerCase();
  let found: string | null = null;
  for (const login of roster) {
    const name = login.toLowerCase();
    // Twitch logins are [a-zA-Z0-9_], so a boundary here is any character
    // outside that set. \b alone would treat "_" as a word character and
    // fail to separate "alpha" from "alpha_bot".
    const pattern = new RegExp(`(^|[^a-z0-9_])${escape(name)}($|[^a-z0-9_])`);
    if (!pattern.test(lowered)) continue;
    if (found !== null) return null;
    found = login;
  }
  return found;
}

/** Escapes regex metacharacters; logins are constrained but this is cheap. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test attribute`
Expected: PASS

- [ ] **Step 5: Store and read the attribution**

In `history.ts`, change `recordEvent` and add `lastActivity`:

```typescript
  recordEvent(
    type: string,
    ts = Date.now(),
    message: string | null = null,
    streamer: string | null = null,
  ): void {
    this.db
      .prepare("INSERT INTO events (ts, type, message, streamer) VALUES (?, ?, ?, ?)")
      .run(ts, type, message, streamer);
  }

  /** The newest attributed event for a streamer, for the card's "last:" line. */
  lastActivity(streamer: string): { ts: number; type: string } | null {
    const row = this.db
      .prepare(
        "SELECT ts, type FROM events WHERE streamer = ? ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(streamer) as { ts: number; type: string } | undefined;
    return row ?? null;
  }
```

In `service.ts`, `ring()` currently calls `this.deps.history.recordEvent(eventType, this.now(), message)`. It needs the roster to attribute against. The roster is already resolved on each refresh — cache it there. Add a private field and set it in `doRefresh` right after `const usernames = await this.deps.getStreamers();`:

```typescript
  /** Last resolved roster, used to attribute doorbell events. */
  private roster: string[] = [];
```

```typescript
    this.roster = usernames;
```

Then in `ring()`:

```typescript
    this.deps.history.recordEvent(
      eventType,
      this.now(),
      message,
      attribute(message, this.roster),
    );
```

Import `attribute` at the top of `service.ts`.

- [ ] **Step 6: Run the full backend suite**

Run: `pnpm --filter @app/backend test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/state/attribute.ts apps/backend/src/state/attribute.test.ts apps/backend/src/db/history.ts apps/backend/src/state/service.ts
git commit -m "feat: attribute miner events to a streamer

Matches the doorbell's message against the known roster -- an
identification against a closed set, not a parse. Ambiguous lines stay
unattributed rather than guessing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Derive the new state fields

The largest task, and the one that changes existing behaviour: `gainedStream` moves off the in-memory map.

**Files:**
- Modify: `apps/backend/src/state/service.ts`
- Test: `apps/backend/src/state/service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 4, 6.
- Produces: `StreamerState` gains `liveSince`, `streamId`, `lastLive`, `lastActivity`, `online24h`, `mined24h`, `minedTotal`, `pointsPerHour`. `RawStreamerState` gains `streamId`, `streamStartedAt`.

- [ ] **Step 1: Write the failing tests**

The `alpha` fixture at the top of `service.test.ts` must gain the new raw fields — update it first:

```typescript
const alpha = (points: number, isOnline = true, stream = "S1") => ({
  streamers: [{
    username: "alpha", channelId: "42", displayName: "Alpha",
    points, isOnline, pointsEnabled: true,
    streamId: isOnline ? stream : null,
    streamStartedAt: isOnline ? 1000 : null,
  }],
});
```

Then add:

```typescript
test("reports the stream start from Twitch, not from when we looked", async () => {
  clock = 3_600_000;
  const { service } = make([alpha(100)]);
  await service.refresh();
  // Twitch says the stream began at 1000; we first looked an hour in.
  expect(service.snapshot().streamers[0].liveSince).toBe(1000);
});

test("keeps the stream gain across a restart", async () => {
  // Simulates a restart: a second service, sharing only the database,
  // sees the same stream id and must recover the anchor from it. The old
  // in-memory map lost this and silently reset the gain to zero.
  const first = make([alpha(100)]).service;
  await first.refresh();
  const second = make([alpha(150)]).service;
  await second.refresh();
  expect(second.snapshot().streamers[0].gainedStream).toBe(50);
});

test("reports a stream gain for a streamer added mid-stream", async () => {
  // No false->true transition was ever observed, so the old map had no
  // anchor and reported null forever.
  const { service } = make([alpha(100), alpha(180)]);
  await service.refresh();
  await service.refresh();
  expect(service.snapshot().streamers[0].gainedStream).toBe(80);
});

test("suppresses points per hour below the mining floor", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  // Only one tick of mining time so far: far under 15 minutes, so a rate
  // here would be a confident four-digit number contradicted next tick.
  expect(service.snapshot().streamers[0].pointsPerHour).toBeNull();
});

test("quantises durations to whole minutes", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  const { online24h, mined24h, minedTotal } = service.snapshot().streamers[0];
  for (const value of [online24h, mined24h, minedTotal]) {
    // Unrounded values change every tick by definition and would make
    // every SSE frame a broadcast to every client.
    expect(value % 60_000).toBe(0);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test service`
Expected: FAIL — `liveSince` undefined

- [ ] **Step 3: Write the implementation**

In `service.ts`: extend `StreamerState`, remove the `streamAnchor` field and its two mutation sites, and rebuild the `.map()`. Replace the `RawStreamerState` type with:

```typescript
export type RawStreamerState = Omit<
  StreamerState,
  "gained24h" | "gainedSince" | "gainedStream" | "spark" | "avatarUrl"
  | "liveSince" | "lastLive" | "lastActivity"
  | "online24h" | "mined24h" | "minedTotal" | "pointsPerHour"
> & { streamStartedAt: number | null };
```

Add to `StreamerState`:

```typescript
  /** Twitch's own stream start; null when offline. A timestamp, not a
   *  duration, so the card ticks it client-side instead of the server
   *  re-sending a changed number every poll. */
  liveSince: number | null;
  /** Identity of the current stream; the anchor key for gainedStream. */
  streamId: string | null;
  /** When this channel was last live; null when live now or never seen. */
  lastLive: number | null;
  lastActivity: { ts: number; type: string } | null;
  /** Milliseconds, rounded to the minute -- see the quantisation note. */
  online24h: number;
  mined24h: number;
  minedTotal: number;
  /** Points per hour mined, or null below MIN_MINED_FOR_RATE_MS. */
  pointsPerHour: number | null;
```

Add near `DAY_MS`:

```typescript
/**
 * Mining time below which points-per-hour is not reported.
 *
 * A handful of points over six minutes extrapolates to a confident
 * four-digit rate that the next tick contradicts. The figure only means
 * something once the denominator is big enough to be stable.
 */
const MIN_MINED_FOR_RATE_MS = 15 * 60_000;

/** Durations reaching the snapshot are whole minutes. Unrounded, they
 *  differ every tick -- an open span always grows -- which would defeat
 *  the change comparison that gates SSE emission. */
const toMinutes = (ms: number) => Math.round(ms / 60_000) * 60_000;
```

Inside the `.map()`, after the `recordPoints` call, replace the anchor block with:

```typescript
        // Upsert on Twitch's stream id rather than reacting to a
        // transition: called on every live tick, so a restart mid-stream
        // finds the existing row and keeps its anchor.
        if (s.isOnline && s.streamId !== null && s.streamStartedAt !== null) {
          this.deps.history.openStreamerSession(
            s.username, s.streamId, s.streamStartedAt,
            typeof s.points === "number" ? s.points : null,
          );
        }
        this.deps.history.closeStreamerSessionsExcept(s.username, s.streamId ?? null, at);

        const anchor = s.streamId === null
          ? null
          : this.deps.history.streamAnchor(s.username, s.streamId);

        const online = clip(this.deps.history.streamerSpans(s.username, dayAgo), dayAgo, at);
        const minerDay = clip(this.deps.history.minerSpans(dayAgo), dayAgo, at);
        const mined24h = total(intersect(online, minerDay));
        const minedTotal = total(intersect(
          clip(this.deps.history.streamerSpans(s.username), 0, at),
          clip(this.deps.history.minerSpans(), 0, at),
        ));
```

and in the returned object, replacing the old `gainedStream` line:

```typescript
          gainedStream:
            anchor === null || typeof s.points !== "number" ? null : s.points - anchor,
          liveSince: s.streamStartedAt,
          lastLive: this.deps.history.lastLive(s.username),
          lastActivity: this.deps.history.lastActivity(s.username),
          online24h: toMinutes(total(online)),
          mined24h: toMinutes(mined24h),
          minedTotal: toMinutes(minedTotal),
          pointsPerHour:
            mined24h < MIN_MINED_FOR_RATE_MS || gained24h === null
              ? null
              : Math.round((gained24h / (mined24h / 3_600_000)) * 10) / 10,
```

`gained24h` is computed inline in the current return object; hoist it to a `const gained24h = ...` above the return so `pointsPerHour` can reuse it rather than recomputing.

Delete the `private streamAnchor = new Map<string, number>();` field and its doc comment, plus the `if (s.isOnline && wasOnline === false ...)` and `if (!s.isOnline) this.streamAnchor.delete(...)` blocks. `wasOnline`/`previous` may become unused — remove them if so, or TypeScript will warn.

Import at the top: `import { clip, intersect, total } from "./spans.js";`

- [ ] **Step 4: Add the miner heartbeat**

In `doRefresh`, right after `this.lastUpdated = at;`:

```typescript
      // Rides the existing poll rather than its own timer: this is
      // exactly the cadence the heartbeat needs, and a second timebase
      // would be one more thing to reconcile when the two disagree.
      this.deps.history.beatMinerSession(at);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test`
Expected: PASS. **Pre-existing `gainedStream` tests will fail** — this task deliberately changes that behaviour. Rewrite them against the persisted anchor; a passing old test means the fix did not land.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/state/service.ts apps/backend/src/state/service.test.ts
git commit -m "feat: derive time-tracking figures for the streamer cards

Also moves gainedStream onto a persisted per-stream anchor, fixing two
bugs: it reset to zero on any restart mid-stream, and never reported at
all for a streamer added mid-stream.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Retention for `point_snapshots`

**Files:**
- Create: `apps/backend/src/config/retention.ts`, `apps/backend/src/config/retention.test.ts`
- Modify: `apps/backend/src/db/history.ts`, `apps/backend/src/index.ts`, `.env.example`
- Test: `apps/backend/src/db/history.test.ts`

**Interfaces:**
- Produces: `resolveRetentionDays(value: string | undefined): number`, `History.prunePoints(olderThan: number): number`

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/config/retention.test.ts`:

```typescript
import { expect, test } from "vitest";
import { resolveRetentionDays, RETENTION_DAYS } from "./retention.js";

test("defaults when unset", () => {
  expect(resolveRetentionDays(undefined)).toBe(RETENTION_DAYS);
  expect(resolveRetentionDays("   ")).toBe(RETENTION_DAYS);
});

test("honours zero as 'never prune'", () => {
  // Must not be a falsy check: 0 is a real setting, not an absent one.
  expect(resolveRetentionDays("0")).toBe(0);
});

test("clamps below one day", () => {
  // Retention shorter than the 24h gain window would erode the gain
  // labels, which read from the same table.
  expect(resolveRetentionDays("0.5")).toBe(1);
});

test("falls back on nonsense", () => {
  expect(resolveRetentionDays("soon")).toBe(RETENTION_DAYS);
  expect(resolveRetentionDays("-5")).toBe(RETENTION_DAYS);
});
```

And in `history.test.ts`:

```typescript
test("prunes snapshots older than the cutoff", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("alpha", 200, 9000);
  expect(history.prunePoints(5000)).toBe(1);
  expect(history.pointsSeries("alpha", 0, 99_999)).toEqual([{ ts: 9000, balance: 200 }]);
});

test("leaves span tables alone", () => {
  // They are the source of the all-time mining figure; pruning them
  // would corrupt the number they exist to answer.
  history.openStreamerSession("alpha", "S1", 1000, 0);
  history.prunePoints(99_999);
  expect(history.streamerSpans("alpha")).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test retention history`
Expected: FAIL — cannot resolve `./retention.js`

- [ ] **Step 3: Write the implementation**

Create `apps/backend/src/config/retention.ts`:

```typescript
/** Days of point history kept by default. */
export const RETENTION_DAYS = 90;

/**
 * Resolves HISTORY_RETENTION_DAYS.
 *
 * `point_snapshots` is the only table that grows per tick, so it is the
 * only one pruned -- the span tables are tiny and are the source of the
 * all-time mining figure.
 *
 * Zero means "never prune" and is honoured, so this cannot be a falsy
 * check. Values under a day clamp to one: the 24h gain window reads the
 * same table, and pruning inside it would erode the gain labels.
 * Nonsense falls back to the default rather than yielding NaN, which
 * would make the cutoff NaN and delete nothing silently.
 */
export function resolveRetentionDays(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return RETENTION_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return RETENTION_DAYS;
  if (days === 0) return 0;
  return Math.max(1, Math.floor(days));
}
```

In `history.ts`:

```typescript
  /** Deletes point snapshots older than `olderThan`. Returns rows removed. */
  prunePoints(olderThan: number): number {
    return this.db
      .prepare("DELETE FROM point_snapshots WHERE ts < ?")
      .run(olderThan).changes;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test retention history`
Expected: PASS

- [ ] **Step 5: Schedule it in `index.ts`**

After `history.recoverOpenSessions();`:

```typescript
const retentionDays = resolveRetentionDays(process.env.HISTORY_RETENTION_DAYS);
if (retentionDays > 0) {
  const prune = () => {
    const removed = history.prunePoints(Date.now() - retentionDays * 86_400_000);
    // VACUUM only when something was actually deleted: it rewrites the
    // whole file, which is not worth doing daily for no reclaimed space.
    if (removed > 0) {
      console.log(`pruned ${removed} point snapshots`);
      db.exec("VACUUM");
    }
  };
  prune();
  // unref() so a pending prune never holds the process open at shutdown.
  setInterval(prune, 86_400_000).unref();
}
```

Import `resolveRetentionDays` from `./config/retention.js`.

- [ ] **Step 6: Document it in `.env.example`**

Add to the dev-mode section, matching the surrounding comment style:

```
# How many days of point history to keep. Pruned on boot and daily after.
# 0 disables pruning entirely. Values under 1 are clamped to 1, since the
# 24h gain figures read the same table. Defaults to 90.
#
# Only point_snapshots is pruned. The session tables that back the
# all-time mining figure are never pruned -- they are tiny, and dropping
# rows would corrupt the number they exist to answer.
HISTORY_RETENTION_DAYS=90
```

- [ ] **Step 7: Verify the build and suite**

Run: `pnpm run build:backend && pnpm --filter @app/backend test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/config/retention.ts apps/backend/src/config/retention.test.ts apps/backend/src/db/history.ts apps/backend/src/db/history.test.ts apps/backend/src/index.ts .env.example
git commit -m "feat: prune point history on a configurable retention

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: `formatSpan` day rollover

**Files:**
- Modify: `apps/frontend/src/lib/formatSpan.ts`
- Test: `apps/frontend/src/lib/formatSpan.test.ts`

**Interfaces:**
- Produces: `formatSpan` unchanged below 48h; days above.

- [ ] **Step 1: Write the failing test**

```typescript
test("rolls over to days past 48h", () => {
  // The all-time mining figure reaches hundreds of hours; "1400h" is a
  // number to decode rather than read.
  expect(formatSpan(142 * 3_600_000)).toBe("6d");
  expect(formatSpan(72 * 3_600_000)).toBe("3d");
});

test("keeps hours up to 48h", () => {
  // Guards every existing caller: gain windows and the 24h figures never
  // reach the new branch, so their labels are untouched.
  expect(formatSpan(47 * 3_600_000)).toBe("47h");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/frontend test formatSpan`
Expected: FAIL — received `"142h"`

- [ ] **Step 3: Write the implementation**

In `formatSpan.ts`, add `const DAY = 24 * HOUR;` and, as the first branch of the function body:

```typescript
  // Past two days, hours stop being readable ("1400h"). Single-unit
  // still -- "6d", not "5d 22h" -- because this sits beside a number as
  // a qualifier, not as a readout of its own.
  if (ms >= 2 * DAY) return `${Math.round(ms / DAY)}d`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/frontend test formatSpan`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/formatSpan.ts apps/frontend/src/lib/formatSpan.test.ts
git commit -m "feat: roll formatSpan over to days past 48h

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Card UI

**Files:**
- Modify: `apps/frontend/src/components/StreamerCard.tsx`, `StreamerCard.module.css`, `apps/frontend/src/api/useLiveState.ts`
- Create: `apps/frontend/src/components/StreamerTimes.tsx`
- Test: `apps/frontend/src/components/StreamerCard.test.tsx`

**Interfaces:**
- Consumes: the `StreamerState` fields from Task 7.
- Produces: `<StreamerTimes streamer={s} />`, rendered by `StreamerCard`.

A separate component because `StreamerCard` is already at a comfortable size, and the ticking clock needs its own state that the card does not otherwise have.

- [ ] **Step 1: Mirror the fields in `useLiveState.ts`**

Add to the frontend `StreamerState` interface — identical names and types to Task 7:

```typescript
  liveSince: number | null;
  streamId: string | null;
  lastLive: number | null;
  lastActivity: { ts: number; type: string } | null;
  online24h: number;
  mined24h: number;
  minedTotal: number;
  pointsPerHour: number | null;
```

- [ ] **Step 2: Write the failing tests**

Add to `StreamerCard.test.tsx`, following its existing render helper and fixture:

```typescript
test("ticks the live duration from the stream start", () => {
  render(<StreamerCard streamer={streamer({
    isOnline: true, liveSince: Date.now() - 3 * 3_600_000 - 24 * 60_000,
  })} />);
  expect(screen.getByTestId("live-duration")).toHaveTextContent("3h 24m");
});

test("shows the last activity", () => {
  render(<StreamerCard streamer={streamer({
    lastActivity: { ts: Date.now() - 4 * 60_000, type: "GAIN_FOR_CLAIM" },
  })} />);
  expect(screen.getByTestId("last-activity")).toHaveTextContent("claim");
  expect(screen.getByTestId("last-activity")).toHaveTextContent("4m ago");
});

test("shows both clocks when they differ", () => {
  render(<StreamerCard streamer={streamer({
    online24h: 8 * 3_600_000, mined24h: 6 * 3_600_000,
  })} />);
  expect(screen.getByTestId("times-24h")).toHaveTextContent("live 8h");
  expect(screen.getByTestId("times-24h")).toHaveTextContent("mined 6h");
});

test("collapses to one figure when the clocks agree", () => {
  // "live 6h · mined 6h" on every card is noise; the gap is the signal.
  render(<StreamerCard streamer={streamer({
    online24h: 6 * 3_600_000, mined24h: 6 * 3_600_000,
  })} />);
  expect(screen.getByTestId("times-24h")).toHaveTextContent("mined 6h");
  expect(screen.getByTestId("times-24h")).not.toHaveTextContent("live 6h");
});

test("shows when an offline channel was last live", () => {
  render(<StreamerCard streamer={streamer({
    isOnline: false, liveSince: null, lastLive: Date.now() - 2 * 86_400_000,
  })} />);
  expect(screen.getByTestId("last-live")).toHaveTextContent("2d ago");
});

test("renders nothing rather than zeros without history", () => {
  // "0h mined" and "we have not watched yet" are different claims.
  render(<StreamerCard streamer={streamer({
    isOnline: false, liveSince: null, lastLive: null,
    online24h: 0, mined24h: 0, minedTotal: 0, lastActivity: null,
  })} />);
  expect(screen.queryByTestId("times-24h")).toBeNull();
  expect(screen.queryByTestId("last-live")).toBeNull();
});
```

Extend the test file's `streamer()` fixture with defaults for every new field so existing tests keep compiling.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @app/frontend test StreamerCard`
Expected: FAIL — no `live-duration` element

- [ ] **Step 4: Write the component**

Create `apps/frontend/src/components/StreamerTimes.tsx`:

```typescript
import { Group, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { formatSpan } from "../lib/formatSpan.js";
import { formatUptime } from "../lib/formatUptime.js";
import type { StreamerState } from "../api/useLiveState.js";

/** Turns GAIN_FOR_CLAIM into "claim". The card wants a short label; the
 *  events feed already renders the miner's full line. */
function activityLabel(type: string): string {
  return type.toLowerCase().replace(/^gain_for_/, "").replace(/_/g, " ");
}

function ago(ts: number, now: number): string {
  return `${formatSpan(Math.max(0, now - ts))} ago`;
}

/**
 * The time block under a card's sparkline.
 *
 * The live duration ticks client-side from `liveSince` rather than
 * arriving in the payload: a server-sent duration would change on every
 * poll and wake every SSE client with a frame nothing meaningful changed
 * in. Same reason the 24h figures arrive quantised to the minute.
 */
export function StreamerTimes({ streamer: s }: { streamer: StreamerState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (s.liveSince === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [s.liveSince]);

  // A gap smaller than a rounding step is not a gap worth two numbers.
  const gap = s.online24h - s.mined24h >= 60_000;
  const hasTimes = s.online24h > 0 || s.mined24h > 0 || s.minedTotal > 0;

  return (
    <>
      <Group justify="space-between" gap="xs" wrap="nowrap">
        {s.liveSince !== null && (
          <Text size="xs" c="dimmed" data-testid="live-duration">
            {formatUptime(now - s.liveSince)}
          </Text>
        )}
        {s.liveSince === null && s.lastLive !== null && (
          <Text size="xs" c="dimmed" data-testid="last-live">
            last live {ago(s.lastLive, now)}
          </Text>
        )}
        {s.lastActivity !== null && (
          <Text size="xs" c="dimmed" truncate data-testid="last-activity">
            {activityLabel(s.lastActivity.type)} {ago(s.lastActivity.ts, now)}
          </Text>
        )}
      </Group>

      {hasTimes && (
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text size="xs" c="dimmed" data-testid="times-24h">
            {gap ? `live ${formatSpan(s.online24h)} · ` : null}
            mined {formatSpan(s.mined24h)}
          </Text>
          {s.minedTotal > 0 && (
            <Text size="xs" c="dimmed" data-testid="mined-total">
              {formatSpan(s.minedTotal)} all-time
            </Text>
          )}
        </Group>
      )}
    </>
  );
}
```



- [ ] **Step 5: Render it from `StreamerCard`**

Import it, and insert after the `<Sparkline />` line:

```tsx
        <StreamerTimes streamer={s} />
```

Add points-per-hour to the existing gains `<Group gap="sm">`:

```tsx
          {s.pointsPerHour !== null && (
            <Text size="xs" c="dimmed" data-testid="points-per-hour">
              {s.pointsPerHour}/h
            </Text>
          )}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @app/frontend test`
Expected: PASS

- [ ] **Step 7: Verify the whole build and suite**

Run: `pnpm run build && pnpm test`
Expected: PASS across backend, frontend and Python.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src
git commit -m "feat: show live duration, activity and mining time on cards

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Verification

After Task 10, confirm the feature works in the real app rather than only in tests:

- [ ] `pnpm test` — all three suites pass.
- [ ] `pnpm dev`, open the Vite URL, sign in. A live streamer's card shows a ticking duration; it matches the channel's actual uptime on Twitch.
- [ ] Restart the backend while a stream is live. The duration and the stream gain continue rather than resetting — this is the bug Task 7 fixes, and the reason `stream_id` is the row's identity.
- [ ] Stop the miner from the UI for a few minutes with a channel live, then restart it. The 24h line should show `live` exceeding `mined` — the two clocks diverging is the whole point of the design.
