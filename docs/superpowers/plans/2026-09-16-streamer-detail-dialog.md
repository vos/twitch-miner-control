# Streamer Detail Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A modal dialog, opened from a dashboard streamer card, showing that channel's points chart, per-stream earnings, activity log and mining coverage — all read from history SQLite already records.

**Architecture:** One reshaped endpoint (`GET /api/history`) returns everything the dialog needs in a single response. All data transforms live in pure functions under `apps/frontend/src/lib/`, tested directly; React components render them. Charts come from `@mantine/charts`, sized explicitly because Recharts renders nothing under jsdom.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React 19, Mantine 9, `@mantine/charts` + recharts, vitest, @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-09-16-streamer-detail-dialog-design.md`

## Global Constraints

- **Never render a confident figure from absent data.** `null` renders an em-dash (`—`), never `0` or `+0`. This mirrors `Gain` in `StreamerCard.tsx:36`. Applies to every figure in every task.
- **Point writes are change-only** (`history.ts:11-18`). A flat stretch has no samples. Never interpolate a slope between two samples; the balance was flat and then jumped.
- **`point_snapshots` prunes at 90 days** (`retention.ts:1`, `RETENTION_DAYS = 90`). The "all" range means "all we kept".
- **Mining figures floor at `first_seen_ts`.** `streamer_sessions.start_ts` is Twitch's `createdAt`, which can predate our first sighting. See `service.ts:651-661`.
- **`anchor_points` is nullable.** When null, points earned for that stream is unknowable — not zero.
- **Miner log message balances are lossy** (millified, `history.ts:78-81`). Read amounts only via `parseActivity`; never sum them.
- **Dependency versions:** `@mantine/charts@^9.6.0` (must match installed `@mantine/core` 9.6.0), `recharts@^3.2.1`.
- **Module imports use the `.js` extension** on relative paths, matching every existing file in this repo.
- Run tests with `pnpm --filter @app/backend test` and `pnpm --filter @app/frontend test`.

---

## File Structure

**Backend**
- Modify `apps/backend/src/db/history.ts` — add `eventsFor`, `sessionsFor`
- Modify `apps/backend/src/db/history.test.ts` — tests for both
- Modify `apps/backend/src/http/server.ts` — reshape `/api/history`, add `streamers` dep
- Modify `apps/backend/src/http/server.test.ts` — tests for the new shape
- Modify `apps/backend/src/index.ts:246-249` — pass `streamers` to `buildServer`

**Frontend — pure transforms (one responsibility each)**
- Create `apps/frontend/src/lib/detailRanges.ts` — range keys → `from`/`to`
- Create `apps/frontend/src/lib/bucketPoints.ts` — series → chart rows
- Create `apps/frontend/src/lib/sessionRows.ts` — sessions → table rows
- Create `apps/frontend/src/lib/coverageRows.ts` — spans → per-day bands
- Plus a `.test.ts` beside each

**Frontend — components**
- Create `apps/frontend/src/api/useStreamerDetail.ts` — fetch hook
- Create `apps/frontend/src/components/StreamerDetailModal.tsx` — shell
- Create `apps/frontend/src/components/PointsChart.tsx`
- Create `apps/frontend/src/components/StreamHistoryTable.tsx`
- Create `apps/frontend/src/components/StreamerActivityLog.tsx`
- Create `apps/frontend/src/components/CoverageTimeline.tsx`
- Modify `apps/frontend/src/components/StreamerCard.tsx` — clickable
- Modify `apps/frontend/src/routes/Dashboard.tsx` — owns open state
- Modify `apps/frontend/src/main.tsx` — charts stylesheet

---

## Task 1: Per-streamer history queries

**Files:**
- Modify: `apps/backend/src/db/history.ts`
- Test: `apps/backend/src/db/history.test.ts`

**Interfaces:**
- Consumes: existing `History` class, `Span` from `../state/spans.js`
- Produces:
  - `interface SessionRow { streamId: string; start: number; end: number | null; anchorPoints: number | null }`
  - `History.eventsFor(streamer: string, limit: number): EventSample[]`
  - `History.sessionsFor(streamer: string, fromTs: number): SessionRow[]`

- [ ] **Step 1: Write the failing tests**

Append to `apps/backend/src/db/history.test.ts`:

```typescript
test("eventsFor returns only that streamer's events, newest first", () => {
  history.recordEvent("GAIN_FOR_CLAIM", 1000, "+50 → x", "alpha");
  history.recordEvent("GAIN_FOR_WATCH", 2000, "+10 → y", "beta");
  history.recordEvent("GAIN_FOR_CLAIM", 3000, "+20 → z", "alpha");
  expect(history.eventsFor("alpha", 10)).toEqual([
    { ts: 3000, type: "GAIN_FOR_CLAIM", message: "+20 → z" },
    { ts: 1000, type: "GAIN_FOR_CLAIM", message: "+50 → x" },
  ]);
});

test("eventsFor excludes unattributed events", () => {
  history.recordEvent("STARTUP", 1000, "booted", null);
  expect(history.eventsFor("alpha", 10)).toEqual([]);
});

test("eventsFor honours the limit", () => {
  history.recordEvent("A", 1000, null, "alpha");
  history.recordEvent("B", 2000, null, "alpha");
  expect(history.eventsFor("alpha", 1)).toEqual([
    { ts: 2000, type: "B", message: null },
  ]);
});

test("sessionsFor returns sessions newest first with their anchors", () => {
  history.openStreamerSession("alpha", "s1", 1000, 100);
  history.openStreamerSession("alpha", "s2", 5000, 300);
  expect(history.sessionsFor("alpha", 0)).toEqual([
    { streamId: "s2", start: 5000, end: null, anchorPoints: 300 },
    { streamId: "s1", start: 1000, end: null, anchorPoints: 100 },
  ]);
});

test("sessionsFor keeps a null anchor null rather than zero", () => {
  history.openStreamerSession("alpha", "s1", 1000, null);
  expect(history.sessionsFor("alpha", 0)[0].anchorPoints).toBeNull();
});

test("sessionsFor excludes sessions that ended before the window", () => {
  history.recordPoints("alpha", 100, 2000);
  history.openStreamerSession("alpha", "old", 1000, 10);
  history.closeStreamerSessionsExcept("alpha", null, 2000);
  expect(history.sessionsFor("alpha", 5000)).toEqual([]);
});

test("sessionsFor ignores other streamers", () => {
  history.openStreamerSession("beta", "s1", 1000, 100);
  expect(history.sessionsFor("alpha", 0)).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @app/backend test -- history`
Expected: FAIL — `history.eventsFor is not a function`

- [ ] **Step 3: Implement both methods**

In `apps/backend/src/db/history.ts`, add the exported interface beside `EventSample`:

```typescript
export interface SessionRow {
  streamId: string;
  start: number;
  end: number | null;
  anchorPoints: number | null;
}
```

Add to the `History` class, next to `lastActivity`:

```typescript
  /**
   * Every attributed event for one streamer, newest first.
   *
   * lastActivity is this query with LIMIT 1. Unattributed rows
   * (streamer NULL) stay invisible here for the same reason they do
   * there: they belong to the roster-wide feed, not to a channel.
   */
  eventsFor(streamer: string, limit: number): EventSample[] {
    return this.db
      .prepare(
        "SELECT ts, type, message FROM events WHERE streamer = ? " +
          "ORDER BY ts DESC, id DESC LIMIT ?",
      )
      .all(streamer, limit) as EventSample[];
  }

  /**
   * A streamer's stream sessions, newest first, with the anchor balance
   * each one started from.
   *
   * `anchorPoints` stays null rather than defaulting: a session opened
   * before any balance was known cannot report what it earned, and zero
   * would be a confident claim that it earned nothing.
   */
  sessionsFor(streamer: string, fromTs: number): SessionRow[] {
    return this.db
      .prepare(
        `SELECT stream_id AS streamId, start_ts AS start, end_ts AS end,
                anchor_points AS anchorPoints
           FROM streamer_sessions
          WHERE streamer = ? AND (end_ts IS NULL OR end_ts >= ?)
          ORDER BY start_ts DESC`,
      )
      .all(streamer, fromTs) as SessionRow[];
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @app/backend test -- history`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/db/history.ts apps/backend/src/db/history.test.ts
git commit -m "$(cat <<'EOF'
feat(db): read events and sessions for one streamer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Reshape `/api/history`

The route currently returns `recentEvents(100)` — the roster-wide feed — while taking a `streamer` it ignores (`server.ts:428-447`). It has no frontend consumer; `grep` finds it only in `server.ts` and `server.test.ts`. Its four existing 400-path tests must keep passing untouched.

**Files:**
- Modify: `apps/backend/src/http/server.ts` (`ServerDeps`, and the route at 428-447)
- Modify: `apps/backend/src/index.ts:246-249`
- Test: `apps/backend/src/http/server.test.ts`

**Interfaces:**
- Consumes: `History.eventsFor`, `History.sessionsFor`, `SessionRow` (Task 1); `Streamers.firstSeen(login): number | null`; `clip`, `intersect`, `total` from `../state/spans.js`
- Produces: the response body

```typescript
{
  series: { ts: number; balance: number }[];
  events: { ts: number; type: string; message: string | null }[];
  sessions: {
    streamId: string; start: number; end: number | null;
    mined: number; earned: number | null;
  }[];
  coverage: { live: Span[]; mined: Span[] };
  firstSeen: number | null;
  retentionFloor: number | null;
}
```

- [ ] **Step 1: Write the failing tests**

Replace the existing `"GET /api/history returns a series"` test in `apps/backend/src/http/server.test.ts` with these. Leave the four validation tests below it (`server.test.ts:328-352`) exactly as they are.

```typescript
test("GET /api/history returns a series", async () => {
  ctx.history.recordPoints("alpha", 10, 1000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().series).toEqual([{ ts: 1000, balance: 10 }]);
});

test("GET /api/history scopes events to the streamer asked for", async () => {
  ctx.history.recordEvent("GAIN_FOR_CLAIM", 1000, "+50", "alpha");
  ctx.history.recordEvent("GAIN_FOR_CLAIM", 2000, "+70", "beta");
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().events).toEqual([
    { ts: 1000, type: "GAIN_FOR_CLAIM", message: "+50" },
  ]);
});

test("GET /api/history reports points earned per stream", async () => {
  ctx.history.openStreamerSession("alpha", "s1", 1000, 100);
  ctx.history.recordPoints("alpha", 180, 4000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().sessions[0].earned).toBe(80);
});

test("GET /api/history leaves earned null when the anchor is unknown", async () => {
  ctx.history.openStreamerSession("alpha", "s1", 1000, null);
  ctx.history.recordPoints("alpha", 180, 4000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().sessions[0].earned).toBeNull();
});

test("GET /api/history reports the oldest kept sample as the retention floor", async () => {
  ctx.history.recordPoints("alpha", 10, 5000);
  ctx.history.recordPoints("alpha", 20, 9000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().retentionFloor).toBe(5000);
});

test("GET /api/history returns empty blocks for an untracked streamer", async () => {
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=nobody&from=0&to=99999", cookies: auth(),
  });
  const body = res.json();
  expect(body.series).toEqual([]);
  expect(body.events).toEqual([]);
  expect(body.sessions).toEqual([]);
  expect(body.retentionFloor).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @app/backend test -- server`
Expected: FAIL — `events` still holds beta's row; `sessions` is undefined.

- [ ] **Step 3: Add the `streamers` dependency**

In `apps/backend/src/http/server.ts`, add the import:

```typescript
import { Streamers } from "../db/streamers.js";
```

and this field to `ServerDeps`, after `history`:

```typescript
  /**
   * The roster store, read for `first_seen_ts` — the floor under every
   * mining figure. Optional, and read defensively, exactly as
   * StateService reads it: a server built without one still answers,
   * with an unfloored figure, rather than failing to build.
   */
  streamers?: Streamers;
```

In `apps/backend/src/index.ts`, add `streamers` to the `buildServer` call at 246-249:

```typescript
const app: AppServer = buildServer({
  configPath, password, doorbellToken, supervisor, stateService, history,
  streamers,
  helper, loginRunner, loginStatus, cookiesDir, staticRoot, secureCookie, trustProxy,
});
```

- [ ] **Step 4: Replace the route body**

Add to the imports at the top of `server.ts`:

```typescript
import { clip, intersect, total } from "../state/spans.js";
```

Replace the `return { ... }` at the end of the `/api/history` handler (`server.ts:443-446`) with:

```typescript
      const login = streamer.data;
      // The floor under every mining figure: streamer_sessions.start_ts
      // is Twitch's own createdAt, so a channel added mid-stream has a
      // session back-dated to a start we were never present for. Without
      // this, that channel's first stream reports its whole length as
      // mined. Composed exactly as state/service.ts does it.
      const firstSeen = deps.streamers?.firstSeen(login) ?? null;
      const floor = firstSeen ?? 0;
      const minerSpans = deps.history.minerSpans();
      const sessions = deps.history.sessionsFor(login, from).map((s) => {
        const end = s.end ?? to;
        const mined = total(intersect(
          clip([{ start: s.start, end: s.end }], floor, end),
          clip(minerSpans, floor, end),
        ));
        // balanceAt, not latest: writes are change-only, so the balance
        // in force at a session's end is the most recent snapshot at or
        // before it. A null anchor means the earning is unknowable.
        const closing = deps.history.balanceAt(login, end);
        const earned = s.anchorPoints === null || closing === null
          ? null
          : closing - s.anchorPoints;
        return { streamId: s.streamId, start: s.start, end: s.end, mined, earned };
      });
      const liveSpans = deps.history.streamerSpans(login, from);
      return {
        series: deps.history.pointsSeries(login, from, to),
        events: deps.history.eventsFor(login, 100),
        sessions,
        coverage: {
          live: clip(liveSpans, Math.max(floor, from), to),
          mined: clip(intersect(liveSpans, minerSpans), Math.max(floor, from), to),
        },
        firstSeen,
        // The oldest sample that survived pruning, so the client can say
        // what the window really covers instead of inferring the channel
        // began at the retention cutoff.
        retentionFloor: deps.history.earliestSample(login)?.ts ?? null,
      };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @app/backend test -- server`
Expected: PASS, including the four pre-existing 400-path tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm run build:backend`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/http/server.ts apps/backend/src/http/server.test.ts apps/backend/src/index.ts
git commit -m "$(cat <<'EOF'
fix(api): scope /api/history to the streamer it is given

It took a streamer parameter and returned the roster-wide event feed.
Now answers with that channel's events, per-stream earnings floored at
first_seen_ts, coverage spans and the retention floor.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Range helper

**Files:**
- Create: `apps/frontend/src/lib/detailRanges.ts`
- Test: `apps/frontend/src/lib/detailRanges.test.ts`

**Interfaces:**
- Produces:
  - `type RangeKey = "24h" | "7d" | "30d" | "all"`
  - `const RANGE_KEYS: readonly RangeKey[]`
  - `const RANGE_LABELS: Record<RangeKey, string>`
  - `rangeWindow(key: RangeKey, now: number): { from: number; to: number }`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/lib/detailRanges.test.ts`:

```typescript
import { expect, test } from "vitest";
import { rangeWindow, RANGE_KEYS, RANGE_LABELS } from "./detailRanges.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

test("24h looks back one day", () => {
  expect(rangeWindow("24h", NOW)).toEqual({ from: NOW - 24 * HOUR, to: NOW });
});

test("7d looks back seven days", () => {
  expect(rangeWindow("7d", NOW)).toEqual({ from: NOW - 7 * 24 * HOUR, to: NOW });
});

test("30d looks back thirty days", () => {
  expect(rangeWindow("30d", NOW)).toEqual({ from: NOW - 30 * 24 * HOUR, to: NOW });
});

test("all starts at zero so the server answers with whatever it kept", () => {
  expect(rangeWindow("all", NOW)).toEqual({ from: 0, to: NOW });
});

test("every key has a label", () => {
  for (const key of RANGE_KEYS) expect(RANGE_LABELS[key]).toBeTruthy();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test -- detailRanges`
Expected: FAIL — cannot resolve `./detailRanges.js`

- [ ] **Step 3: Implement**

Create `apps/frontend/src/lib/detailRanges.ts`:

```typescript
/**
 * The detail dialog's time windows.
 *
 * "all" sends from=0 rather than a computed floor: point history prunes
 * at 90 days by default, so only the server knows how far back anything
 * actually survives. It answers with what it kept and reports the oldest
 * sample as `retentionFloor`, which is what the chart labels itself by.
 */
export type RangeKey = "24h" | "7d" | "30d" | "all";

export const RANGE_KEYS: readonly RangeKey[] = ["24h", "7d", "30d", "all"];

export const RANGE_LABELS: Record<RangeKey, string> = {
  "24h": "24h",
  "7d": "7 days",
  "30d": "30 days",
  all: "All",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SPANS: Record<Exclude<RangeKey, "all">, number> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

export function rangeWindow(key: RangeKey, now: number): { from: number; to: number } {
  if (key === "all") return { from: 0, to: now };
  return { from: now - SPANS[key], to: now };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test -- detailRanges`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/detailRanges.ts apps/frontend/src/lib/detailRanges.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): add detail dialog range windows

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Point bucketing

The chart shows two views over one series: cumulative balance, and gain per bucket. Both must respect change-only writes — a gap between samples is a flat balance, never a slope.

**Files:**
- Create: `apps/frontend/src/lib/bucketPoints.ts`
- Test: `apps/frontend/src/lib/bucketPoints.test.ts`

**Interfaces:**
- Consumes: `RangeKey` from `./detailRanges.js`
- Produces:
  - `interface PointSample { ts: number; balance: number }`
  - `interface ChartRow { ts: number; balance: number; gain: number }`
  - `bucketPoints(series: PointSample[], key: RangeKey, from: number, to: number): ChartRow[]`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/lib/bucketPoints.test.ts`:

```typescript
import { expect, test } from "vitest";
import { bucketPoints } from "./bucketPoints.js";

const HOUR = 3_600_000;

test("an empty series charts nothing", () => {
  expect(bucketPoints([], "24h", 0, 24 * HOUR)).toEqual([]);
});

test("a single sample charts one row with no gain", () => {
  // No earlier balance to difference against: the gain is unknown, and
  // reporting the balance itself as a gain would invent a huge one.
  const rows = bucketPoints([{ ts: HOUR, balance: 500 }], "24h", 0, 24 * HOUR);
  expect(rows).toEqual([{ ts: HOUR, balance: 500, gain: 0 }]);
});

test("gain is the difference from the previous bucket, not the balance", () => {
  const rows = bucketPoints(
    [{ ts: HOUR, balance: 100 }, { ts: 2 * HOUR, balance: 160 }],
    "24h", 0, 24 * HOUR,
  );
  expect(rows.map((r) => r.gain)).toEqual([0, 60]);
});

test("a flat stretch holds the balance rather than sloping to the next sample", () => {
  // Writes are change-only: nothing between these two timestamps means
  // the balance did not move, so every bucket between them carries the
  // earlier balance and a zero gain.
  const rows = bucketPoints(
    [{ ts: 0, balance: 100 }, { ts: 3 * HOUR, balance: 200 }],
    "24h", 0, 3 * HOUR,
  );
  const middle = rows.slice(0, -1);
  expect(middle.every((r) => r.balance === 100)).toBe(true);
  expect(middle.every((r) => r.gain === 0)).toBe(true);
  expect(rows[rows.length - 1]).toEqual({ ts: 3 * HOUR, balance: 200, gain: 100 });
});

test("samples inside one bucket collapse to the bucket's closing balance", () => {
  const rows = bucketPoints(
    [
      { ts: 0, balance: 100 },
      { ts: 60_000, balance: 120 },
      { ts: 120_000, balance: 140 },
    ],
    "30d", 0, 30 * 24 * HOUR,
  );
  expect(rows[0].balance).toBe(140);
});

test("a falling balance reports a negative gain", () => {
  const rows = bucketPoints(
    [{ ts: HOUR, balance: 500 }, { ts: 2 * HOUR, balance: 400 }],
    "24h", 0, 24 * HOUR,
  );
  expect(rows[rows.length - 1].gain).toBe(-100);
});

test("samples outside the window are excluded", () => {
  const rows = bucketPoints(
    [{ ts: 0, balance: 50 }, { ts: 10 * HOUR, balance: 90 }],
    "24h", 5 * HOUR, 24 * HOUR,
  );
  expect(rows.every((r) => r.ts >= 5 * HOUR)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test -- bucketPoints`
Expected: FAIL — cannot resolve `./bucketPoints.js`

- [ ] **Step 3: Implement**

Create `apps/frontend/src/lib/bucketPoints.ts`:

```typescript
import type { RangeKey } from "./detailRanges.js";

export interface PointSample {
  ts: number;
  balance: number;
}

export interface ChartRow {
  ts: number;
  /** The balance in force at the end of this bucket. */
  balance: number;
  /** Change from the previous bucket. Zero for the first row. */
  gain: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Bucket width per range, chosen so a chart holds 24-60 points. */
const BUCKET: Record<RangeKey, number> = {
  "24h": HOUR,
  "7d": 6 * HOUR,
  "30d": 24 * HOUR,
  all: 24 * HOUR,
};

/**
 * Turns change-only balance snapshots into evenly spaced chart rows.
 *
 * The central rule: a gap between samples is a FLAT balance, not a
 * gradual climb. recordPoints writes only when the balance moves, so a
 * quiet week is two rows in the table; drawing a line between them would
 * claim steady earning across days when nothing happened. Each bucket
 * therefore carries the last balance at or before it, and a bucket with
 * no sample repeats the one before it with a zero gain.
 *
 * `gain` is the first difference of that series, which is the figure
 * worth looking at: a cumulative balance is nearly flat at most zooms.
 * The first row's gain is 0 rather than its balance -- there is no
 * earlier bucket to difference against, and treating the opening balance
 * as earnings would invent an enormous one.
 */
export function bucketPoints(
  series: PointSample[],
  key: RangeKey,
  from: number,
  to: number,
): ChartRow[] {
  const inWindow = series.filter((s) => s.ts >= from && s.ts <= to);
  if (inWindow.length === 0) return [];

  const width = BUCKET[key];
  const start = inWindow[0].ts;
  const rows: ChartRow[] = [];
  let index = 0;
  let balance = inWindow[0].balance;
  let previous: number | null = null;

  for (let edge = start; edge <= to; edge += width) {
    const bound = edge + width;
    // Every sample landing in this bucket; the last one wins, since the
    // bucket reports the balance in force when it closed.
    while (index < inWindow.length && inWindow[index].ts < bound) {
      balance = inWindow[index].balance;
      index += 1;
    }
    const ts = index >= inWindow.length ? Math.min(bound - width, to) : edge;
    rows.push({ ts, balance, gain: previous === null ? 0 : balance - previous });
    previous = balance;
    if (index >= inWindow.length) break;
  }

  // The final sample may land past the last bucket edge; it is the most
  // recent truth and must not be dropped off the right of the chart.
  const last = inWindow[inWindow.length - 1];
  const tail = rows[rows.length - 1];
  if (tail.balance !== last.balance) {
    rows.push({ ts: last.ts, balance: last.balance, gain: last.balance - tail.balance });
  }
  return rows;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test -- bucketPoints`
Expected: PASS. If a test fails, fix the implementation — the tests encode the spec's constraint and are not to be relaxed.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/bucketPoints.ts apps/frontend/src/lib/bucketPoints.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): bucket change-only point snapshots for charting

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Stream table rows

**Files:**
- Create: `apps/frontend/src/lib/sessionRows.ts`
- Test: `apps/frontend/src/lib/sessionRows.test.ts`

**Interfaces:**
- Produces:
  - `interface DetailSession { streamId: string; start: number; end: number | null; mined: number; earned: number | null }`
  - `interface StreamRow { streamId: string; start: number; end: number | null; live: boolean; length: number; mined: number; earned: number | null; coverage: number | null }`
  - `sessionRows(sessions: DetailSession[], now: number): StreamRow[]`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/lib/sessionRows.test.ts`:

```typescript
import { expect, test } from "vitest";
import { sessionRows } from "./sessionRows.js";

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

const session = (over: Partial<Parameters<typeof sessionRows>[0][number]> = {}) => ({
  streamId: "s1", start: NOW - 4 * HOUR, end: NOW - 2 * HOUR,
  mined: 2 * HOUR, earned: 500, ...over,
});

test("computes length from start and end", () => {
  expect(sessionRows([session()], NOW)[0].length).toBe(2 * HOUR);
});

test("an open session is marked live and measured to now", () => {
  const row = sessionRows([session({ end: null, start: NOW - HOUR })], NOW)[0];
  expect(row.live).toBe(true);
  expect(row.length).toBe(HOUR);
});

test("coverage is the mined fraction of the stream", () => {
  const row = sessionRows([session({ mined: HOUR })], NOW)[0];
  expect(row.coverage).toBeCloseTo(0.5);
});

test("coverage of a zero-length stream is null, not a division by zero", () => {
  const row = sessionRows([session({ start: NOW, end: NOW, mined: 0 })], NOW)[0];
  expect(row.coverage).toBeNull();
});

test("coverage never exceeds one even if mined overshoots", () => {
  // Clock skew between the session table and the miner spans must not
  // produce a 140% coverage badge.
  const row = sessionRows([session({ mined: 9 * HOUR })], NOW)[0];
  expect(row.coverage).toBe(1);
});

test("a null earned stays null rather than becoming zero", () => {
  expect(sessionRows([session({ earned: null })], NOW)[0].earned).toBeNull();
});

test("preserves the order it is given", () => {
  const rows = sessionRows(
    [session({ streamId: "b" }), session({ streamId: "a" })], NOW,
  );
  expect(rows.map((r) => r.streamId)).toEqual(["b", "a"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test -- sessionRows`
Expected: FAIL — cannot resolve `./sessionRows.js`

- [ ] **Step 3: Implement**

Create `apps/frontend/src/lib/sessionRows.ts`:

```typescript
/** One stream session as the detail endpoint reports it. */
export interface DetailSession {
  streamId: string;
  start: number;
  end: number | null;
  /** Milliseconds of this stream the miner was actually up for. */
  mined: number;
  /** Points earned, or null when the session has no anchor balance. */
  earned: number | null;
}

export interface StreamRow extends DetailSession {
  /** The session is still open. */
  live: boolean;
  length: number;
  /** Mined fraction, 0-1, or null when the stream has no measurable length. */
  coverage: number | null;
}

/**
 * Prepares stream sessions for the detail table.
 *
 * Order is left alone: the endpoint already returns newest first, and
 * re-sorting here would silently disagree with it.
 *
 * `coverage` is clamped to 1. The two figures come from different tables
 * -- stream sessions from Twitch's timestamps, mined time from the
 * miner's own spans -- so a little skew between them is normal, and a
 * row claiming 140% coverage would read as a bug in the reader rather
 * than the rounding it is.
 */
export function sessionRows(sessions: DetailSession[], now: number): StreamRow[] {
  return sessions.map((s) => {
    const live = s.end === null;
    const length = Math.max(0, (s.end ?? now) - s.start);
    return {
      ...s,
      live,
      length,
      coverage: length === 0 ? null : Math.min(1, s.mined / length),
    };
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test -- sessionRows`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/sessionRows.ts apps/frontend/src/lib/sessionRows.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): derive stream table rows from sessions

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Coverage bands

**Files:**
- Create: `apps/frontend/src/lib/coverageRows.ts`
- Test: `apps/frontend/src/lib/coverageRows.test.ts`

**Interfaces:**
- Produces:
  - `interface Span { start: number; end: number | null }`
  - `interface Band { startFraction: number; endFraction: number }`
  - `interface CoverageDay { dayStart: number; live: Band[]; mined: Band[]; liveMs: number; minedMs: number }`
  - `coverageRows(live: Span[], mined: Span[], days: number, now: number): CoverageDay[]`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/lib/coverageRows.test.ts`:

```typescript
import { expect, test } from "vitest";
import { coverageRows } from "./coverageRows.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A midnight boundary in UTC; tests below are written against local days,
// so they assert on relationships rather than absolute offsets.
const NOW = 10 * DAY;

test("returns one row per requested day, oldest first", () => {
  const rows = coverageRows([], [], 3, NOW);
  expect(rows).toHaveLength(3);
  expect(rows[0].dayStart).toBeLessThan(rows[2].dayStart);
});

test("a day with no streams has empty bands and zero totals", () => {
  const rows = coverageRows([], [], 1, NOW);
  expect(rows[0].live).toEqual([]);
  expect(rows[0].mined).toEqual([]);
  expect(rows[0].liveMs).toBe(0);
});

test("a stream inside one day produces a band on that day", () => {
  const rows = coverageRows([{ start: NOW - 3 * HOUR, end: NOW - HOUR }], [], 1, NOW);
  const today = rows[rows.length - 1];
  expect(today.live).toHaveLength(1);
  expect(today.liveMs).toBe(2 * HOUR);
});

test("bands are fractions of the day, between zero and one", () => {
  const rows = coverageRows([{ start: NOW - 3 * HOUR, end: NOW - HOUR }], [], 1, NOW);
  const band = rows[rows.length - 1].live[0];
  expect(band.startFraction).toBeGreaterThanOrEqual(0);
  expect(band.endFraction).toBeLessThanOrEqual(1);
  expect(band.startFraction).toBeLessThan(band.endFraction);
});

test("a stream spanning midnight appears on both days", () => {
  const rows = coverageRows([{ start: NOW - 30 * HOUR, end: NOW - 20 * HOUR }], [], 3, NOW);
  const touched = rows.filter((r) => r.live.length > 0);
  expect(touched.length).toBeGreaterThanOrEqual(2);
});

test("an open span is resolved against now rather than running forever", () => {
  const rows = coverageRows([{ start: NOW - 2 * HOUR, end: null }], [], 1, NOW);
  expect(rows[rows.length - 1].liveMs).toBe(2 * HOUR);
});

test("mined time is tracked separately from live time", () => {
  const rows = coverageRows(
    [{ start: NOW - 4 * HOUR, end: NOW }],
    [{ start: NOW - HOUR, end: NOW }],
    1, NOW,
  );
  const today = rows[rows.length - 1];
  expect(today.liveMs).toBe(4 * HOUR);
  expect(today.minedMs).toBe(HOUR);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test -- coverageRows`
Expected: FAIL — cannot resolve `./coverageRows.js`

- [ ] **Step 3: Implement**

Create `apps/frontend/src/lib/coverageRows.ts`:

```typescript
export interface Span {
  start: number;
  /** Null while still running; resolved against `now` when read. */
  end: number | null;
}

/** A stretch of one day, as fractions of that day's width. */
export interface Band {
  startFraction: number;
  endFraction: number;
}

export interface CoverageDay {
  /** Local midnight opening this day. */
  dayStart: number;
  live: Band[];
  mined: Band[];
  liveMs: number;
  minedMs: number;
}

const DAY = 86_400_000;

/** Local midnight at or before `ts`. Local, not UTC: the rows are labelled
 *  with dates a person reads off their own calendar. */
function midnight(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The portion of `span` falling inside one day, as fractions of it. */
function bandsFor(spans: Span[], dayStart: number, now: number): {
  bands: Band[];
  ms: number;
} {
  const dayEnd = dayStart + DAY;
  const bands: Band[] = [];
  let ms = 0;
  for (const span of spans) {
    const start = Math.max(span.start, dayStart);
    // An open span ends at now, never at the day's end: a day in the past
    // with a still-open span must not report a full 24 hours.
    const end = Math.min(span.end ?? now, dayEnd, now);
    if (end <= start) continue;
    ms += end - start;
    bands.push({
      startFraction: (start - dayStart) / DAY,
      endFraction: (end - dayStart) / DAY,
    });
  }
  return { bands, ms };
}

/**
 * Splits live and mined spans into per-day bands for the coverage strip.
 *
 * A stream crossing midnight is split, appearing on both days -- the
 * strip is a calendar, so a span has to be cut at the boundary rather
 * than assigned to whichever day it started in.
 *
 * Returned oldest first, so the rows read downward like a calendar.
 */
export function coverageRows(
  live: Span[],
  mined: Span[],
  days: number,
  now: number,
): CoverageDay[] {
  const today = midnight(now);
  const rows: CoverageDay[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    // Via midnight() rather than subtracting a fixed 24h: a DST boundary
    // makes a local day 23 or 25 hours long, and stepping by a constant
    // would drift the rows off midnight for every day before it.
    const dayStart = midnight(today - i * DAY);
    const liveDay = bandsFor(live, dayStart, now);
    const minedDay = bandsFor(mined, dayStart, now);
    rows.push({
      dayStart,
      live: liveDay.bands,
      mined: minedDay.bands,
      liveMs: liveDay.ms,
      minedMs: minedDay.ms,
    });
  }
  return rows;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test -- coverageRows`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/lib/coverageRows.ts apps/frontend/src/lib/coverageRows.test.ts
git commit -m "$(cat <<'EOF'
feat(lib): split live and mined spans into per-day coverage bands

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Detail fetch hook

**Files:**
- Create: `apps/frontend/src/api/useStreamerDetail.ts`
- Test: `apps/frontend/src/api/useStreamerDetail.test.ts`

**Interfaces:**
- Consumes: `api` from `./client.js`; `rangeWindow`, `RangeKey` from `../lib/detailRanges.js`; `PointSample` (Task 4); `DetailSession` (Task 5); `Span` (Task 6)
- Produces:
  - `interface StreamerDetail { series: PointSample[]; events: { ts: number; type: string; message: string | null }[]; sessions: DetailSession[]; coverage: { live: Span[]; mined: Span[] }; firstSeen: number | null; retentionFloor: number | null }`
  - `useStreamerDetail(login: string | null, range: RangeKey): { detail: StreamerDetail | null; loading: boolean; error: string | null }`

Check `apps/frontend/src/api/client.ts` for `api`'s exact signature before writing; use it the way `useLiveState.ts` does.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/api/useStreamerDetail.test.ts`:

```typescript
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useStreamerDetail } from "./useStreamerDetail.js";

const EMPTY = {
  series: [], events: [], sessions: [],
  coverage: { live: [], mined: [] },
  firstSeen: null, retentionFloor: null,
};

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: true, status: 200, json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

test("fetches nothing while no streamer is selected", () => {
  const fetchMock = stubFetch(EMPTY);
  renderHook(() => useStreamerDetail(null, "7d"));
  expect(fetchMock).not.toHaveBeenCalled();
});

test("requests the selected streamer and range", async () => {
  const fetchMock = stubFetch(EMPTY);
  renderHook(() => useStreamerDetail("alpha", "7d"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const url = String(fetchMock.mock.calls[0][0]);
  expect(url).toContain("streamer=alpha");
  expect(url).toContain("from=");
  expect(url).toContain("to=");
});

test("exposes the detail once it lands", async () => {
  stubFetch({ ...EMPTY, series: [{ ts: 1000, balance: 10 }] });
  const { result } = renderHook(() => useStreamerDetail("alpha", "7d"));
  await waitFor(() => expect(result.current.detail).not.toBeNull());
  expect(result.current.detail?.series).toEqual([{ ts: 1000, balance: 10 }]);
  expect(result.current.loading).toBe(false);
});

test("reports a failure rather than hanging on loading", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  const { result } = renderHook(() => useStreamerDetail("alpha", "7d"));
  await waitFor(() => expect(result.current.error).not.toBeNull());
  expect(result.current.loading).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test -- useStreamerDetail`
Expected: FAIL — cannot resolve `./useStreamerDetail.js`

- [ ] **Step 3: Implement**

Create `apps/frontend/src/api/useStreamerDetail.ts`:

```typescript
import { useEffect, useState } from "react";
import { api } from "./client.js";
import { rangeWindow, type RangeKey } from "../lib/detailRanges.js";
import type { PointSample } from "../lib/bucketPoints.js";
import type { DetailSession } from "../lib/sessionRows.js";
import type { Span } from "../lib/coverageRows.js";

export interface StreamerDetail {
  series: PointSample[];
  events: { ts: number; type: string; message: string | null }[];
  sessions: DetailSession[];
  coverage: { live: Span[]; mined: Span[] };
  firstSeen: number | null;
  /** The oldest point sample that survived pruning, or null. */
  retentionFloor: number | null;
}

/**
 * Loads one streamer's history, once per open and once per range change.
 *
 * Deliberately not live: the dialog is read for seconds, and reconciling
 * an SSE frame against fetched history would buy very little. The header
 * above it renders from the dashboard's own snapshot, so the figures a
 * viewer watches move are live regardless.
 *
 * A stale response is dropped rather than applied: switching range twice
 * quickly can land the first answer after the second, which would
 * silently show the wrong window.
 */
export function useStreamerDetail(login: string | null, range: RangeKey): {
  detail: StreamerDetail | null;
  loading: boolean;
  error: string | null;
} {
  const [detail, setDetail] = useState<StreamerDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (login === null) {
      setDetail(null);
      setError(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    const { from, to } = rangeWindow(range, Date.now());
    const query = new URLSearchParams({
      streamer: login, from: String(from), to: String(to),
    });
    api<StreamerDetail>(`/api/history?${query}`)
      .then((body) => {
        if (!live) return;
        setDetail(body);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : "failed to load history");
        setLoading(false);
      });
    return () => { live = false; };
  }, [login, range]);

  return { detail, loading, error };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test -- useStreamerDetail`
Expected: PASS. If `api`'s signature differs from the assumption above, adapt the call — it is the one thing here read from another module.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/api/useStreamerDetail.ts apps/frontend/src/api/useStreamerDetail.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add the streamer detail fetch hook

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Modal shell and the clickable card

Ships a working dialog with a header and empty blocks. Tasks 9-12 fill the blocks in.

**Files:**
- Create: `apps/frontend/src/components/StreamerDetailModal.tsx`
- Create: `apps/frontend/src/components/StreamerDetailModal.test.tsx`
- Modify: `apps/frontend/src/components/StreamerCard.tsx`
- Modify: `apps/frontend/src/routes/Dashboard.tsx`

**Interfaces:**
- Consumes: `useStreamerDetail` (Task 7); `RANGE_KEYS`, `RANGE_LABELS`, `RangeKey` (Task 3); existing `StreamerAvatar`, `StatusPill`, `StreamerState`
- Produces:
  - `StreamerDetailModal({ streamer, opened, onClose }: { streamer: StreamerState | null; opened: boolean; onClose: () => void })`
  - `StreamerCard` gains an optional `onOpen?: () => void` prop

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/components/StreamerDetailModal.test.tsx`:

```typescript
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { StreamerCard } from "./StreamerCard.js";
import { StreamerDetailModal } from "./StreamerDetailModal.js";
import type { StreamerState } from "../api/useLiveState.js";

function streamer(over: Partial<StreamerState> = {}): StreamerState {
  return {
    username: "alpha", displayName: "Alpha", channelId: null, points: 1000,
    isOnline: true, pointsEnabled: true, gained24h: 100, gainedSince: null,
    gainedStream: 50, spark: [1, 2], avatarUrl: null, liveSince: Date.now() - 3600_000,
    streamId: "s1", lastLive: null, lastActivity: null, online24h: 0,
    mined24h: 0, minedTotal: 0, pointsPerHour: null, ...over,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({
      series: [], events: [], sessions: [],
      coverage: { live: [], mined: [] }, firstSeen: null, retentionFloor: null,
    }),
  })));
}

test("the card calls onOpen when clicked", async () => {
  const onOpen = vi.fn();
  renderApp(<StreamerCard streamer={streamer()} onOpen={onOpen} />);
  await userEvent.click(screen.getByTestId("streamer-alpha"));
  expect(onOpen).toHaveBeenCalled();
});

test("the card opens on Enter, so it is reachable without a mouse", async () => {
  const onOpen = vi.fn();
  renderApp(<StreamerCard streamer={streamer()} onOpen={onOpen} />);
  screen.getByTestId("streamer-alpha").focus();
  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalled();
});

test("clicking the twitch link does not open the dialog", async () => {
  // The name is an anchor to twitch.tv and must keep working; a card-wide
  // handler that swallowed it would break the card's only outbound link.
  const onOpen = vi.fn();
  renderApp(<StreamerCard streamer={streamer()} onOpen={onOpen} />);
  await userEvent.click(screen.getByRole("link", { name: "Alpha" }));
  expect(onOpen).not.toHaveBeenCalled();
});

test("the dialog names the streamer it is about", async () => {
  stubFetch();
  renderApp(
    <StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />,
  );
  expect(await screen.findByTestId("detail-title")).toHaveTextContent("Alpha");
});

test("the dialog closes on Escape", async () => {
  stubFetch();
  const onClose = vi.fn();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={onClose} />);
  await screen.findByTestId("detail-title");
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalled();
});

test("renders nothing when no streamer is selected", () => {
  renderApp(<StreamerDetailModal streamer={null} opened={false} onClose={() => {}} />);
  expect(screen.queryByTestId("detail-title")).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @app/frontend test -- StreamerDetailModal`
Expected: FAIL — cannot resolve `./StreamerDetailModal.js`

- [ ] **Step 3: Make the card clickable**

In `apps/frontend/src/components/StreamerCard.tsx`, change the signature:

```typescript
export function StreamerCard({ streamer: s, onOpen }: {
  streamer: StreamerState;
  onOpen?: () => void;
}) {
```

and replace the opening `<div>` (currently `StreamerCard.tsx:58-61`) with:

```tsx
    <div
      className={`${classes.card} ${live ? classes.live : classes.offline}`}
      data-testid={`streamer-${s.username}`}
      // The card is a button only when something is listening. Without a
      // handler it keeps its plain-div semantics rather than announcing
      // an action that does nothing.
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `Details for ${s.displayName ?? s.username}` : undefined}
      onClick={onOpen === undefined ? undefined : (event) => {
        // The card already holds a link to twitch.tv and the goal
        // disclosure button. A click that started inside either belongs
        // to it, not to the card.
        if ((event.target as HTMLElement).closest("a, button")) return;
        onOpen();
      }}
      onKeyDown={onOpen === undefined ? undefined : (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        // Space scrolls the page by default, which on a grid of cards
        // moves the very thing just activated.
        event.preventDefault();
        onOpen();
      }}
    >
```

- [ ] **Step 4: Write the modal shell**

Create `apps/frontend/src/components/StreamerDetailModal.tsx`:

```tsx
import { Alert, Group, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useStreamerDetail } from "../api/useStreamerDetail.js";
import { RANGE_KEYS, RANGE_LABELS, type RangeKey } from "../lib/detailRanges.js";
import { StatusPill } from "./StatusPill.js";
import { StreamerAvatar } from "./StreamerAvatar.js";
import type { StreamerState } from "../api/useLiveState.js";

const nf = new Intl.NumberFormat("en-US");

/**
 * The deep view of one streamer: the history SQLite has been recording
 * all along and the card has no room for.
 *
 * The header renders from the dashboard's own snapshot rather than the
 * fetch, so it paints the instant the dialog opens and only the charts
 * below it wait on the network.
 */
export function StreamerDetailModal({ streamer: s, opened, onClose }: {
  streamer: StreamerState | null;
  opened: boolean;
  onClose: () => void;
}) {
  const [range, setRange] = useState<RangeKey>("7d");
  const { detail, loading, error } = useStreamerDetail(
    opened && s !== null ? s.username : null,
    range,
  );

  if (s === null) return null;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="xl"
      title={
        <Group gap="sm" wrap="nowrap" data-testid="detail-title">
          <StreamerAvatar
            login={s.username}
            displayName={s.displayName}
            avatarUrl={s.avatarUrl}
            size={32}
            live={s.isOnline === true}
          />
          <Text fw={600}>{s.displayName ?? s.username}</Text>
          <StatusPill
            isOnline={s.isOnline}
            liveSince={s.liveSince}
            lastLive={s.lastLive}
            elapsed={null}
          />
        </Group>
      }
    >
      <Stack gap="lg">
        <Group gap="lg" wrap="wrap">
          <Text size="sm" data-testid="detail-balance">
            {s.points === null ? "—" : nf.format(s.points)} points
          </Text>
          <Text size="sm" c="dimmed">
            {s.gained24h === null
              ? "— 24h"
              : `${s.gained24h > 0 ? "+" : ""}${nf.format(s.gained24h)} 24h`}
          </Text>
        </Group>

        <SegmentedControl
          value={range}
          onChange={(value) => setRange(value as RangeKey)}
          data={RANGE_KEYS.map((key) => ({ value: key, label: RANGE_LABELS[key] }))}
          size="xs"
          data-testid="detail-range"
        />

        {error !== null && <Alert role="alert" color="red">{error}</Alert>}
        {loading && <Text size="sm" c="dimmed">Loading history…</Text>}

        {/* Blocks land here in Tasks 9-12. */}
        {detail !== null && <div data-testid="detail-blocks" />}
      </Stack>
    </Modal>
  );
}
```

- [ ] **Step 5: Wire it into the dashboard**

In `apps/frontend/src/routes/Dashboard.tsx`, add the import and state, then pass `onOpen` to both `StreamerCard` call sites (currently lines 233 and 245) and render one modal.

Import:

```typescript
import { StreamerDetailModal } from "../components/StreamerDetailModal.js";
```

Beside the other `useState`/`useLocalToggle` calls in the component body:

```typescript
  // One dialog for the whole grid, not one per card: a fifty-streamer
  // roster would otherwise mount fifty modals to show at most one.
  const [openLogin, setOpenLogin] = useState<string | null>(null);
```

Add `useState` to the existing `react` import if it is not already there.

Both card call sites become:

```tsx
        {live.map((s) => (
          <StreamerCard
            key={s.username}
            streamer={s}
            onOpen={() => setOpenLogin(s.username)}
          />
        ))}
```

```tsx
          {others.map((s) => (
            <StreamerCard
              key={s.username}
              streamer={s}
              onOpen={() => setOpenLogin(s.username)}
            />
          ))}
```

And immediately before the closing `</>` of the final `return frame(...)`, after `<EventsFeed enabled={feedOn} />`:

```tsx
      <StreamerDetailModal
        streamer={snapshot.streamers.find((s) => s.username === openLogin) ?? null}
        opened={openLogin !== null}
        onClose={() => setOpenLogin(null)}
      />
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @app/frontend test`
Expected: PASS, including every pre-existing card and dashboard test.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/components/StreamerDetailModal.tsx apps/frontend/src/components/StreamerDetailModal.test.tsx apps/frontend/src/components/StreamerCard.tsx apps/frontend/src/routes/Dashboard.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): open a detail dialog from a streamer card

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Points chart

**Files:**
- Create: `apps/frontend/src/components/PointsChart.tsx`
- Create: `apps/frontend/src/components/PointsChart.test.tsx`
- Modify: `apps/frontend/src/main.tsx`
- Modify: `apps/frontend/src/components/StreamerDetailModal.tsx`
- Modify: `apps/frontend/package.json` (via pnpm)

**Interfaces:**
- Consumes: `bucketPoints`, `ChartRow` (Task 4); `RangeKey` (Task 3)
- Produces: `PointsChart({ series, range, from, to, retentionFloor }: { series: PointSample[]; range: RangeKey; from: number; to: number; retentionFloor: number | null })`

**Recharts renders nothing under jsdom.** `ResponsiveContainer` measures with `ResizeObserver` (a no-op stub in `test-setup.ts`) and `getBoundingClientRect` (jsdom reports 0x0). So: the chart takes explicit `w`/`h`, and these tests assert on the surrounding DOM and on `bucketPoints` — never on chart internals, which would pass against an empty SVG.

- [ ] **Step 1: Install the dependencies**

```bash
pnpm --filter @app/frontend add @mantine/charts@^9.6.0 recharts@^3.2.1
```

- [ ] **Step 2: Import the stylesheet**

In `apps/frontend/src/main.tsx`, directly after the existing core styles import on line 1:

```typescript
import "@mantine/core/styles.css";
// After the core styles, which it builds on: charts imported first lose
// their tooltip and colour rules to the core sheet.
import "@mantine/charts/styles.css";
```

- [ ] **Step 3: Write the failing test**

Create `apps/frontend/src/components/PointsChart.test.tsx`:

```typescript
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { PointsChart } from "./PointsChart.js";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

const series = [
  { ts: NOW - 3 * HOUR, balance: 100 },
  { ts: NOW - HOUR, balance: 180 },
];

test("shows an empty state rather than a blank chart", () => {
  renderApp(
    <PointsChart series={[]} range="24h" from={NOW - 24 * HOUR} to={NOW} retentionFloor={null} />,
  );
  expect(screen.getByTestId("points-chart-empty")).toBeInTheDocument();
});

test("renders the chart once there is a series", () => {
  renderApp(
    <PointsChart series={series} range="24h" from={NOW - 24 * HOUR} to={NOW} retentionFloor={null} />,
  );
  expect(screen.getByTestId("points-chart")).toBeInTheDocument();
  expect(screen.queryByTestId("points-chart-empty")).toBeNull();
});

test("offers both a balance and a gain view", async () => {
  renderApp(
    <PointsChart series={series} range="24h" from={NOW - 24 * HOUR} to={NOW} retentionFloor={null} />,
  );
  const toggle = screen.getByTestId("points-chart-view");
  expect(toggle).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: /gain/i }));
  expect(screen.getByTestId("points-chart")).toBeInTheDocument();
});

test("names the retention floor on the all range", () => {
  // Otherwise a channel tracked for two years looks like it began at the
  // pruning cutoff.
  renderApp(
    <PointsChart
      series={series} range="all" from={0} to={NOW}
      retentionFloor={NOW - 90 * 24 * HOUR}
    />,
  );
  expect(screen.getByTestId("retention-note")).toBeInTheDocument();
});

test("does not claim a retention floor on a short range", () => {
  renderApp(
    <PointsChart
      series={series} range="24h" from={NOW - 24 * HOUR} to={NOW}
      retentionFloor={NOW - 90 * 24 * HOUR}
    />,
  );
  expect(screen.queryByTestId("retention-note")).toBeNull();
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test -- PointsChart`
Expected: FAIL — cannot resolve `./PointsChart.js`

- [ ] **Step 5: Implement**

Create `apps/frontend/src/components/PointsChart.tsx`:

```tsx
import { AreaChart, BarChart } from "@mantine/charts";
import { Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { bucketPoints, type PointSample } from "../lib/bucketPoints.js";
import type { RangeKey } from "../lib/detailRanges.js";

const nf = new Intl.NumberFormat("en-US");

/** Explicit, not responsive: Recharts' ResponsiveContainer measures with
 *  ResizeObserver and getBoundingClientRect, both of which report nothing
 *  under jsdom -- so a responsive chart renders an empty SVG in tests
 *  while every assertion about it still passes. */
const CHART_HEIGHT = 240;

const dateLabel = (ts: number, range: RangeKey) =>
  new Date(ts).toLocaleString(undefined,
    range === "24h"
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" });

/**
 * One channel's balance over time, and the gains that moved it.
 *
 * Two views over one series. The balance answers "where am I", but it is
 * nearly flat at most zooms -- a channel earning steadily draws a line
 * that barely leaves its own axis. The gain view differences it, which is
 * where the answer to "when was this channel actually earning" lives.
 *
 * The area chart steps rather than slopes: point writes are change-only,
 * so a gap between samples is a balance that did not move. A curve
 * through it would claim gradual earning across a stretch where nothing
 * happened at all.
 */
export function PointsChart({ series, range, from, to, retentionFloor }: {
  series: PointSample[];
  range: RangeKey;
  from: number;
  to: number;
  retentionFloor: number | null;
}) {
  const [view, setView] = useState<"balance" | "gain">("balance");
  const rows = bucketPoints(series, range, from, to);

  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="points-chart-empty">
        No points history in this window yet.
      </Text>
    );
  }

  const data = rows.map((row) => ({
    label: dateLabel(row.ts, range),
    Balance: row.balance,
    Gain: row.gain,
  }));

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
          POINTS
        </Text>
        <SegmentedControl
          value={view}
          onChange={(value) => setView(value as "balance" | "gain")}
          data={[{ value: "balance", label: "Balance" }, { value: "gain", label: "Gain" }]}
          size="xs"
          data-testid="points-chart-view"
        />
      </Group>

      <div data-testid="points-chart">
        {view === "balance" ? (
          <AreaChart
            h={CHART_HEIGHT}
            data={data}
            dataKey="label"
            series={[{ name: "Balance", color: "teal.6" }]}
            curveType="step"
            withDots={false}
            valueFormatter={(value) => nf.format(value)}
          />
        ) : (
          <BarChart
            h={CHART_HEIGHT}
            data={data}
            dataKey="label"
            series={[{ name: "Gain", color: "teal.6" }]}
            valueFormatter={(value) => nf.format(value)}
          />
        )}
      </div>

      {range === "all" && retentionFloor !== null && (
        <Text size="xs" c="dimmed" data-testid="retention-note">
          History kept from {new Date(retentionFloor).toLocaleDateString()} — older
          samples have been pruned.
        </Text>
      )}
    </Stack>
  );
}
```

- [ ] **Step 6: Render it in the dialog**

In `StreamerDetailModal.tsx`, add the imports:

```typescript
import { PointsChart } from "./PointsChart.js";
import { rangeWindow } from "../lib/detailRanges.js";
```

Replace the `{detail !== null && <div data-testid="detail-blocks" />}` placeholder with:

```tsx
        {detail !== null && (() => {
          const { from, to } = rangeWindow(range, Date.now());
          return (
            <PointsChart
              series={detail.series}
              range={range}
              from={from}
              to={to}
              retentionFloor={detail.retentionFloor}
            />
          );
        })()}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @app/frontend test`
Expected: PASS. If a Recharts import breaks the jsdom run, confirm the chart has explicit `h` and no `ResponsiveContainer` — that is the known failure mode.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend/src/components/PointsChart.tsx apps/frontend/src/components/PointsChart.test.tsx apps/frontend/src/components/StreamerDetailModal.tsx apps/frontend/src/main.tsx apps/frontend/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(dashboard): chart a streamer's points history

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Stream history table

**Files:**
- Create: `apps/frontend/src/components/StreamHistoryTable.tsx`
- Create: `apps/frontend/src/components/StreamHistoryTable.test.tsx`
- Modify: `apps/frontend/src/components/StreamerDetailModal.tsx`

**Interfaces:**
- Consumes: `sessionRows`, `DetailSession` (Task 5)
- Produces: `StreamHistoryTable({ sessions }: { sessions: DetailSession[] })`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/StreamHistoryTable.test.tsx`:

```typescript
import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { StreamHistoryTable } from "./StreamHistoryTable.js";

const HOUR = 3_600_000;
const NOW = Date.now();

const session = (over = {}) => ({
  streamId: "s1", start: NOW - 4 * HOUR, end: NOW - 2 * HOUR,
  mined: 2 * HOUR, earned: 500, ...over,
});

test("shows an empty state when no streams are on record", () => {
  renderApp(<StreamHistoryTable sessions={[]} />);
  expect(screen.getByTestId("streams-empty")).toBeInTheDocument();
});

test("renders one row per stream", () => {
  renderApp(
    <StreamHistoryTable sessions={[session(), session({ streamId: "s2" })]} />,
  );
  expect(screen.getAllByTestId("stream-row")).toHaveLength(2);
});

test("shows what a stream earned", () => {
  renderApp(<StreamHistoryTable sessions={[session()]} />);
  expect(screen.getByTestId("stream-row")).toHaveTextContent("+500");
});

test("shows an em-dash, not zero, when the earning is unknown", () => {
  // A session with no anchor balance cannot report earnings. "+0" would
  // claim the stream earned nothing, which is a different fact.
  renderApp(<StreamHistoryTable sessions={[session({ earned: null })]} />);
  const row = screen.getByTestId("stream-row");
  expect(within(row).getByTestId("stream-earned")).toHaveTextContent("—");
  expect(within(row).getByTestId("stream-earned")).not.toHaveTextContent("0");
});

test("marks a stream that was mostly missed", () => {
  renderApp(<StreamHistoryTable sessions={[session({ mined: 6 * 60_000 })]} />);
  expect(screen.getByTestId("low-coverage")).toBeInTheDocument();
});

test("does not mark a well-covered stream", () => {
  renderApp(<StreamHistoryTable sessions={[session({ mined: 2 * HOUR })]} />);
  expect(screen.queryByTestId("low-coverage")).toBeNull();
});

test("marks a still-running stream as live", () => {
  renderApp(
    <StreamHistoryTable sessions={[session({ end: null, start: NOW - HOUR })]} />,
  );
  expect(screen.getByTestId("stream-row")).toHaveTextContent(/live/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test -- StreamHistoryTable`
Expected: FAIL — cannot resolve `./StreamHistoryTable.js`

- [ ] **Step 3: Implement**

Create `apps/frontend/src/components/StreamHistoryTable.tsx`:

```tsx
import { Badge, Stack, Table, Text } from "@mantine/core";
import { sessionRows, type DetailSession } from "../lib/sessionRows.js";

const nf = new Intl.NumberFormat("en-US");

/** How many streams the table shows before it stops. Enough to see a
 *  pattern; short enough not to turn the dialog into a scroll. */
const LIMIT = 20;

/** Coverage below this is worth pointing at: most of the stream was missed. */
const LOW_COVERAGE = 0.5;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Truncated, never rounded up: this is a claim about time actually
 *  spent, and rounding would overstate it. Matches StreamerTimes. */
function duration(ms: number): string {
  if (ms < MINUTE) return "0m";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * One row per stream: how long it ran, how much of it we mined, what it
 * earned.
 *
 * This is the table that answers "is this channel worth keeping", which
 * no chart does -- a balance line says points arrived, not whether the
 * streams producing them are ones we are actually present for.
 */
export function StreamHistoryTable({ sessions }: { sessions: DetailSession[] }) {
  const rows = sessionRows(sessions, Date.now()).slice(0, LIMIT);

  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="streams-empty">
        No streams recorded for this channel yet.
      </Text>
    );
  }

  return (
    <Stack gap="xs">
      <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
        STREAMS
      </Text>
      <Table.ScrollContainer minWidth={420}>
        <Table striped={false} highlightOnHover verticalSpacing="xs" fz="sm">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Length</Table.Th>
              <Table.Th>Mined</Table.Th>
              <Table.Th ta="right">Earned</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={row.streamId} data-testid="stream-row">
                <Table.Td>
                  {new Date(row.start).toLocaleDateString(undefined,
                    { month: "short", day: "numeric" })}
                  {row.live && (
                    <Badge color="twitch" variant="light" size="xs" ml={6}>live</Badge>
                  )}
                </Table.Td>
                <Table.Td>{duration(row.length)}</Table.Td>
                <Table.Td>
                  {duration(row.mined)}
                  {row.coverage !== null && row.coverage < LOW_COVERAGE && (
                    // The one actionable signal in the dialog: the stream
                    // ran and we were not there for most of it.
                    <Badge
                      color="yellow" variant="light" size="xs" ml={6}
                      data-testid="low-coverage"
                    >
                      {Math.round(row.coverage * 100)}%
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td ta="right" data-testid="stream-earned">
                  {row.earned === null
                    ? "—"
                    : `${row.earned > 0 ? "+" : ""}${nf.format(row.earned)}`}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {sessions.length > LIMIT && (
        <Text size="xs" c="dimmed">
          Showing {LIMIT} of {sessions.length} recorded streams.
        </Text>
      )}
    </Stack>
  );
}
```

- [ ] **Step 4: Render it in the dialog**

In `StreamerDetailModal.tsx`, import it and add it inside the `detail !== null` block, after `<PointsChart .../>`:

```typescript
import { StreamHistoryTable } from "./StreamHistoryTable.js";
```

```tsx
              <StreamHistoryTable sessions={detail.sessions} />
```

Wrap the two blocks in a fragment if the arrow function currently returns a single element.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @app/frontend test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/components/StreamHistoryTable.tsx apps/frontend/src/components/StreamHistoryTable.test.tsx apps/frontend/src/components/StreamerDetailModal.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): list per-stream length, coverage and earnings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Per-streamer activity log

**Files:**
- Create: `apps/frontend/src/components/StreamerActivityLog.tsx`
- Create: `apps/frontend/src/components/StreamerActivityLog.test.tsx`
- Modify: `apps/frontend/src/components/StreamerDetailModal.tsx`

**Interfaces:**
- Consumes: `parseActivity(type: string, message?: string | null): { earned: number | null; label: string }` from `../lib/parseActivity.js`
- Produces: `StreamerActivityLog({ events }: { events: { ts: number; type: string; message: string | null }[] })`

Read `apps/frontend/src/lib/parseActivity.ts` before writing: amounts come only from `parseActivity`, and the balance inside a miner message is millified and must never be parsed.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/StreamerActivityLog.test.tsx`:

```typescript
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { StreamerActivityLog } from "./StreamerActivityLog.js";

const NOW = Date.now();

test("shows an empty state when nothing has happened", () => {
  renderApp(<StreamerActivityLog events={[]} />);
  expect(screen.getByTestId("activity-empty")).toBeInTheDocument();
});

test("renders one entry per event", () => {
  renderApp(
    <StreamerActivityLog
      events={[
        { ts: NOW, type: "GAIN_FOR_CLAIM", message: null },
        { ts: NOW - 1000, type: "GAIN_FOR_WATCH", message: null },
      ]}
    />,
  );
  expect(screen.getAllByTestId("activity-entry")).toHaveLength(2);
});

test("shows the amount the miner reported", () => {
  renderApp(
    <StreamerActivityLog
      events={[{
        ts: NOW, type: "GAIN_FOR_CLAIM",
        message: "🚀  +50 → Streamer(username=alpha, channel_points=12.3k) - Reason: CLAIM.",
      }]}
    />,
  );
  expect(screen.getByTestId("activity-entry")).toHaveTextContent("+50");
});

test("falls back to the event label when the message carries no amount", () => {
  // The miner is vendored and can reformat its logs; an unparseable line
  // must lose the amount, never the entry.
  renderApp(
    <StreamerActivityLog
      events={[{ ts: NOW, type: "STREAMER_ONLINE", message: "something unexpected" }]}
    />,
  );
  const entry = screen.getByTestId("activity-entry");
  expect(entry).toBeInTheDocument();
  expect(entry).not.toHaveTextContent("+");
});

test("groups entries under a day heading", () => {
  renderApp(
    <StreamerActivityLog
      events={[
        { ts: NOW, type: "GAIN_FOR_CLAIM", message: null },
        { ts: NOW - 3 * 86_400_000, type: "GAIN_FOR_CLAIM", message: null },
      ]}
    />,
  );
  expect(screen.getAllByTestId("activity-day")).toHaveLength(2);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test -- StreamerActivityLog`
Expected: FAIL — cannot resolve `./StreamerActivityLog.js`

- [ ] **Step 3: Implement**

Create `apps/frontend/src/components/StreamerActivityLog.tsx`:

```tsx
import { Group, ScrollArea, Stack, Text } from "@mantine/core";
import { parseActivity } from "../lib/parseActivity.js";

const nf = new Intl.NumberFormat("en-US");

export interface ActivityEvent {
  ts: number;
  type: string;
  message: string | null;
}

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const dayKey = (ts: number) => new Date(ts).toLocaleDateString();

/**
 * This channel's own event history.
 *
 * Every line goes through parseActivity, the same reader the card's LAST
 * line uses, so the wording matches between the two. It is also the only
 * safe reader: the balance inside a miner log line went through millify()
 * and reads "12.3k", while the *earned* figure beside it is an exact
 * integer from PubSub. Nothing here sums anything.
 */
export function StreamerActivityLog({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="activity-empty">
        No activity recorded for this channel yet.
      </Text>
    );
  }

  const days: { key: string; events: ActivityEvent[] }[] = [];
  for (const event of events) {
    const key = dayKey(event.ts);
    const last = days[days.length - 1];
    if (last !== undefined && last.key === key) last.events.push(event);
    else days.push({ key, events: [event] });
  }

  return (
    <Stack gap="xs">
      <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
        ACTIVITY
      </Text>
      <ScrollArea.Autosize mah={260} type="auto">
        <Stack gap="sm">
          {days.map((day) => (
            <Stack key={day.key} gap={4}>
              <Text size="xs" c="dimmed" data-testid="activity-day">{day.key}</Text>
              {day.events.map((event, index) => {
                const { earned, label } = parseActivity(event.type, event.message);
                return (
                  <Group
                    key={`${event.ts}-${index}`}
                    gap="xs"
                    wrap="nowrap"
                    data-testid="activity-entry"
                  >
                    {earned !== null && (
                      <Text size="xs" c="teal" fw={600}>+{nf.format(earned)}</Text>
                    )}
                    <Text size="xs" style={{ flex: 1 }} truncate>{label}</Text>
                    <Text size="xs" c="dimmed">{time(event.ts)}</Text>
                  </Group>
                );
              })}
            </Stack>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}
```

- [ ] **Step 4: Render it in the dialog**

In `StreamerDetailModal.tsx`, import and add it after `<StreamHistoryTable .../>`:

```typescript
import { StreamerActivityLog } from "./StreamerActivityLog.js";
```

```tsx
              <StreamerActivityLog events={detail.events} />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @app/frontend test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/components/StreamerActivityLog.tsx apps/frontend/src/components/StreamerActivityLog.test.tsx apps/frontend/src/components/StreamerDetailModal.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): show one channel's own activity history

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Coverage timeline

The block that earns the dialog: it shows points being lost, which nothing else in the UI reports. Hand-rolled SVG rather than Recharts — this is a Gantt-like band, not a chart type Recharts does well.

**Files:**
- Create: `apps/frontend/src/components/CoverageTimeline.tsx`
- Create: `apps/frontend/src/components/CoverageTimeline.test.tsx`
- Modify: `apps/frontend/src/components/StreamerDetailModal.tsx`

**Interfaces:**
- Consumes: `coverageRows`, `Span`, `CoverageDay` (Task 6)
- Produces: `CoverageTimeline({ coverage, days }: { coverage: { live: Span[]; mined: Span[] }; days: number })`

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/CoverageTimeline.test.tsx`:

```typescript
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { CoverageTimeline } from "./CoverageTimeline.js";

const HOUR = 3_600_000;
const NOW = Date.now();

test("renders one row per day requested", () => {
  renderApp(<CoverageTimeline coverage={{ live: [], mined: [] }} days={7} />);
  expect(screen.getAllByTestId("coverage-day")).toHaveLength(7);
});

test("draws a band for a stream", () => {
  renderApp(
    <CoverageTimeline
      coverage={{ live: [{ start: NOW - 3 * HOUR, end: NOW - HOUR }], mined: [] }}
      days={1}
    />,
  );
  expect(screen.getAllByTestId("live-band").length).toBeGreaterThan(0);
});

test("draws the mined stretch over the live one", () => {
  renderApp(
    <CoverageTimeline
      coverage={{
        live: [{ start: NOW - 3 * HOUR, end: NOW }],
        mined: [{ start: NOW - HOUR, end: NOW }],
      }}
      days={1}
    />,
  );
  expect(screen.getAllByTestId("mined-band").length).toBeGreaterThan(0);
});

test("reports mined against live hours for the day", () => {
  renderApp(
    <CoverageTimeline
      coverage={{
        live: [{ start: NOW - 4 * HOUR, end: NOW }],
        mined: [{ start: NOW - HOUR, end: NOW }],
      }}
      days={1}
    />,
  );
  expect(screen.getByTestId("coverage-total")).toHaveTextContent("1h");
  expect(screen.getByTestId("coverage-total")).toHaveTextContent("4h");
});

test("a day with no streams reports an em-dash rather than zero of zero", () => {
  renderApp(<CoverageTimeline coverage={{ live: [], mined: [] }} days={1} />);
  expect(screen.getByTestId("coverage-total")).toHaveTextContent("—");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test -- CoverageTimeline`
Expected: FAIL — cannot resolve `./CoverageTimeline.js`

- [ ] **Step 3: Implement**

Create `apps/frontend/src/components/CoverageTimeline.tsx`:

```tsx
import { Group, Stack, Text } from "@mantine/core";
import { coverageRows, type Span } from "../lib/coverageRows.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The band's coordinate space; it renders fluid via preserveAspectRatio. */
const TRACK_WIDTH = 100;
const TRACK_HEIGHT = 10;

function duration(ms: number): string {
  if (ms < MINUTE) return "0m";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  return `${Math.floor(ms / HOUR)}h`;
}

/**
 * A day-by-day strip of when this channel was live, and how much of that
 * we were actually mining.
 *
 * The gap between the two tones is the point of the block: a channel that
 * streamed eight hours while the miner was down earned nothing, and no
 * other view in the app says so. Hand-rolled SVG rather than a chart
 * library -- these are interval bands on a fixed 24-hour track, which is
 * a Gantt row, not a plot.
 */
export function CoverageTimeline({ coverage, days }: {
  coverage: { live: Span[]; mined: Span[] };
  days: number;
}) {
  const rows = coverageRows(coverage.live, coverage.mined, days, Date.now());

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center">
        <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
          COVERAGE
        </Text>
        <Text size="xs" c="dimmed">mined / live</Text>
      </Group>

      {rows.map((row) => (
        <Group key={row.dayStart} gap="sm" wrap="nowrap" data-testid="coverage-day">
          <Text size="xs" c="dimmed" style={{ width: 52, flexShrink: 0 }}>
            {new Date(row.dayStart).toLocaleDateString(undefined,
              { month: "short", day: "numeric" })}
          </Text>
          <svg
            width="100%"
            height={TRACK_HEIGHT}
            viewBox={`0 0 ${TRACK_WIDTH} ${TRACK_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
            style={{ display: "block", flex: 1 }}
          >
            <rect
              x={0} y={0} width={TRACK_WIDTH} height={TRACK_HEIGHT}
              fill="var(--tw-border)" fillOpacity={0.35} rx={1}
            />
            {row.live.map((band, i) => (
              <rect
                key={`live-${i}`}
                data-testid="live-band"
                x={band.startFraction * TRACK_WIDTH}
                y={0}
                width={Math.max(0.4, (band.endFraction - band.startFraction) * TRACK_WIDTH)}
                height={TRACK_HEIGHT}
                fill="var(--tw-live)"
                fillOpacity={0.35}
              />
            ))}
            {row.mined.map((band, i) => (
              <rect
                key={`mined-${i}`}
                data-testid="mined-band"
                x={band.startFraction * TRACK_WIDTH}
                y={0}
                width={Math.max(0.4, (band.endFraction - band.startFraction) * TRACK_WIDTH)}
                height={TRACK_HEIGHT}
                fill="var(--tw-success)"
              />
            ))}
          </svg>
          <Text
            size="xs" c="dimmed" data-testid="coverage-total"
            style={{ width: 72, flexShrink: 0, textAlign: "right" }}
          >
            {/* A day the channel never streamed has nothing to report --
                "0m / 0m" reads as a failure to mine rather than as an
                absence of anything to mine. */}
            {row.liveMs === 0
              ? "—"
              : `${duration(row.minedMs)} / ${duration(row.liveMs)}`}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
```

All three custom properties are defined in `apps/frontend/src/theme.css`: `--tw-live` (the live-state red, used by `StatusPill` and the card's live dot), `--tw-success` (the sparkline's green) and `--tw-border`. There is no `--tw-twitch` — live time uses `--tw-live`, which is the same colour the rest of the UI already means by "this channel is live".

- [ ] **Step 4: Render it in the dialog**

In `StreamerDetailModal.tsx`, import it and add it after `<StreamerActivityLog .../>`:

```typescript
import { CoverageTimeline } from "./CoverageTimeline.js";
```

```tsx
              <CoverageTimeline
                coverage={detail.coverage}
                days={range === "24h" ? 1 : range === "7d" ? 7 : 14}
              />
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS across both packages.

- [ ] **Step 6: Build to confirm types**

Run: `pnpm run build`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend/src/components/CoverageTimeline.tsx apps/frontend/src/components/CoverageTimeline.test.tsx apps/frontend/src/components/StreamerDetailModal.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): show mining coverage against live time per day

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Verify in the running app

Tests prove the transforms. This proves the dialog opens, paints and reads correctly against real data — including the chart, which the jsdom suite deliberately does not assert on.

**Files:** none (verification only)

- [ ] **Step 1: Start the app**

Run: `pnpm dev`
Wait for the frontend dev server to report a URL.

- [ ] **Step 2: Open a streamer dialog**

Click a card on the dashboard. Confirm:
- The dialog opens with the name, avatar and status in the title.
- The points chart **draws a visible line** — this is the check the test suite cannot make.
- Switching Balance/Gain redraws it.
- Switching range refetches and the chart changes.
- The stream table, activity log and coverage strip all render.

- [ ] **Step 3: Check the honesty cases**

- A newly added channel shows per-block empty states, not errors or zeros.
- Any stream with no anchor shows `—` in Earned, never `+0`.
- On the "all" range, the retention note names a date.
- Clicking the streamer's name still opens twitch.tv and does **not** open the dialog.

- [ ] **Step 4: Check it keyboard-navigates**

Tab to a card, press Enter, confirm the dialog opens; press Escape, confirm it closes and focus returns to the card.

- [ ] **Step 5: Report findings**

If anything above misbehaves, fix it and re-run the affected task's tests before committing. Note anything left unresolved in the handoff rather than marking the plan complete.

---

## Self-Review

**Spec coverage.** Every section maps to a task: endpoint reshape and the two queries → Tasks 1-2; the five data constraints → the Global Constraints block plus specific tests in Tasks 1, 2, 4, 5 and 10; the four content blocks → Tasks 9-12; card trigger and modal shell → Task 8; the Recharts/jsdom constraint → Task 9 Step 3 and the `CHART_HEIGHT` comment; the three `lib/` modules → Tasks 4-6; range handling → Task 3.

**Type consistency.** `DetailSession` is defined in Task 5 and consumed by Tasks 7, 10. `PointSample` is defined in Task 4 and consumed by Tasks 7, 9. `Span` is defined in Task 6 and consumed by Tasks 7, 12. `RangeKey` is defined in Task 3 and consumed by Tasks 4, 7, 8, 9. `SessionRow` (backend, Task 1) and `StreamRow` (frontend, Task 5) are deliberately distinct: the backend row carries `anchorPoints`, the frontend row carries the derived `earned`, `coverage` and `live`.

**Known deviations from the spec.** Two, both deliberate:
- The spec's file list named `bucketPoints`, `sessionRows` and `coverageRows`; this plan adds `detailRanges.ts` (Task 3) because both the hook and the chart need the window maths and duplicating it would let them disagree.
- The spec described the coverage strip as "last 7/30"; Task 12 uses 1/7/14 days keyed to the selected range, since 30 rows of bands is taller than the dialog.
