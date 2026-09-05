# Streamer Card Gains, Sparkline & Events Feed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard streamer card answer "is the miner actually earning?" by showing points gained (per-stream and 24h), a 24h sparkline, and the health signals already present in state but rendered nowhere.

**Architecture:** All derived values are computed in `StateService` during refresh and attached to `StreamerState`, so they ride the existing SSE `state` frame with no new fetching and no second polling path. Per-stream gain is anchored to the `isOnline` false→true transition the poller already observes — *not* to event rows, because the miner's log records carry no streamer identity (see Constraints). The sparkline series is time-bucketed and downsampled server-side to a bounded ~24 points so frame size does not grow with a streamer's activity.

**Tech Stack:** TypeScript, better-sqlite3, Fastify, React 19, Mantine 8, Vitest, @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-29-twitch-miner-web-ui-design.md` (§SQLite, §API surface). This plan extends that spec's `point_snapshots` usage; the spec's `events(ts, type, streamer_id?)` optional streamer column is explicitly **not** implemented — see Constraints.

## Global Constraints

- **Prototype, no backward compatibility.** Schema, API shape, and state types may change freely. `history.db` may be deleted rather than migrated. Do not write migration or compatibility code.
- **Never store message text.** `python/helpers/doorbell.py` forwards only `{event, ts}`; the `events` table stores event type only. Do not parse streamer names out of log messages, and do not edit `vendor/miner/**` to add them.
- **No streamer identity on events.** The miner's event log records carry only `emoji` and `event` in their `extra` dict (`vendor/miner/TwitchChannelPointsMiner/classes/entities/Streamer.py:218-238`). The events feed therefore shows type + time only, and the `events` table schema is unchanged by this plan.
- **Derived fields must be deterministic, not wall-clock varying.** `StateService.doRefresh` detects change via `JSON.stringify(this.streamers)` (`apps/backend/src/state/service.ts:117-127`). Every field attached to a streamer must be computed *before* that comparison and must not encode "time since now", or every refresh would emit a spurious `change` and wake every SSE client.
- **A real 0 and "unknown" must never render identically.** Established precedent: the `total-points` comment in `apps/frontend/src/routes/Dashboard.tsx`. `null` gain renders `—`; numeric `0` renders `0`.
- **Commit straight to `main`.** No feature branches (project convention).
- Backend tests: `pnpm --filter @app/backend test`. Frontend tests: `pnpm --filter @app/frontend test`.

---

## File Structure

**Backend**
- `apps/backend/src/db/history.ts` — add `balanceAt()` and `bucketedSeries()` queries. Owns all SQL.
- `apps/backend/src/state/gains.ts` *(new)* — pure downsampling/bucketing helper. Separated from `History` because it is arithmetic with no database dependency, and from `service.ts` because it deserves its own focused tests.
- `apps/backend/src/state/service.ts` — track online-transition anchors, attach derived fields to `StreamerState`.
- `apps/backend/src/http/server.ts` — add `events` to the payload the dashboard needs.

**Frontend**
- `apps/frontend/src/components/Sparkline.tsx` *(new)* — presentational inline SVG, no data fetching.
- `apps/frontend/src/components/StreamerCard.tsx` *(new)* — one card. Extracted from `Dashboard.tsx` because the card grows from 2 lines to ~6 elements with conditional badges, and both the live and offline grids render it.
- `apps/frontend/src/components/EventsFeed.tsx` *(new)* — the recent-activity list.
- `apps/frontend/src/api/useLiveState.ts` — mirror the new `StreamerState` fields.
- `apps/frontend/src/routes/Dashboard.tsx` — compose the above.

---

### Task 1: History queries for gains and bucketed series

**Files:**
- Modify: `apps/backend/src/db/history.ts`
- Test: `apps/backend/src/db/history.test.ts`

**Interfaces:**
- Consumes: existing `History` class, `Db` from `./schema.js`.
- Produces: `History.balanceAt(username: string, ts: number): number | null` — the balance as of a moment, i.e. the most recent snapshot at or before `ts`, or `null` if the streamer had no snapshot yet. `History.seriesSince(username: string, fromTs: number): PointSample[]` — ascending samples with `ts >= fromTs`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/backend/src/db/history.test.ts`:

```ts
test("balanceAt returns the balance in force at a moment, not the nearest one", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("alpha", 500, 5000);
  // 4900 is nearer to 5000, but at that instant the balance was still 100.
  expect(history.balanceAt("alpha", 4900)).toBe(100);
  expect(history.balanceAt("alpha", 5000)).toBe(500);
});

test("balanceAt returns null before the first snapshot", () => {
  history.recordPoints("alpha", 100, 1000);
  expect(history.balanceAt("alpha", 999)).toBe(null);
});

test("balanceAt is per streamer", () => {
  history.recordPoints("alpha", 100, 1000);
  history.recordPoints("beta", 700, 1000);
  expect(history.balanceAt("beta", 2000)).toBe(700);
});

test("seriesSince returns ascending samples from the cutoff", () => {
  history.recordPoints("alpha", 1, 1000);
  history.recordPoints("alpha", 2, 2000);
  history.recordPoints("alpha", 3, 3000);
  expect(history.seriesSince("alpha", 2000)).toEqual([
    { ts: 2000, balance: 2 },
    { ts: 3000, balance: 3 },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test -- history`
Expected: FAIL — `history.balanceAt is not a function`.

- [ ] **Step 3: Implement the queries**

Add to the `History` class in `apps/backend/src/db/history.ts`:

```ts
  /**
   * The balance in force at `ts`: the most recent snapshot at or before it.
   *
   * Not the *nearest* snapshot -- writes are change-only, so a balance
   * written at 1000 is still the truth at 4999 even when the next write
   * lands at 5000. Anchoring a gain to the nearer row would report a
   * delta that spans a change the window does not contain.
   */
  balanceAt(username: string, ts: number): number | null {
    const row = this.db
      .prepare(
        "SELECT balance FROM point_snapshots WHERE streamer = ? AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .get(username, ts) as { balance: number } | undefined;
    return row ? row.balance : null;
  }

  seriesSince(username: string, fromTs: number): PointSample[] {
    return this.db
      .prepare(
        "SELECT ts, balance FROM point_snapshots WHERE streamer = ? AND ts >= ? ORDER BY ts ASC",
      )
      .all(username, fromTs) as PointSample[];
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test -- history`
Expected: PASS (all history tests, old and new).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/db/history.ts apps/backend/src/db/history.test.ts
git commit -m "feat: add point-in-time balance and since-cutoff series queries"
```

---

### Task 2: Sparkline downsampling helper

**Files:**
- Create: `apps/backend/src/state/gains.ts`
- Test: `apps/backend/src/state/gains.test.ts`

**Interfaces:**
- Consumes: `PointSample` from `../db/history.js`.
- Produces: `downsample(samples: PointSample[], fromTs: number, toTs: number, buckets = 24): number[]` — bucket count is a fixed-length array of balances for the sparkline to draw. Returns `[]` for empty input.

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/state/gains.test.ts`:

```ts
import { expect, test } from "vitest";
import { downsample } from "./gains.js";

test("returns an empty array when there is nothing to draw", () => {
  expect(downsample([], 0, 1000, 4)).toEqual([]);
});

test("buckets by time, not by row, so a burst does not dominate the shape", () => {
  // Three rows in the first bucket, one in the last. Row-based sampling
  // would render the burst as most of the line; time bucketing must not.
  const samples = [
    { ts: 10, balance: 1 }, { ts: 20, balance: 2 }, { ts: 30, balance: 3 },
    { ts: 900, balance: 9 },
  ];
  expect(downsample(samples, 0, 1000, 4)).toEqual([3, 3, 3, 9]);
});

test("carries the last known balance through quiet buckets", () => {
  // Change-only writes mean a quiet hour has no row; it is flat, not absent.
  const samples = [{ ts: 10, balance: 5 }, { ts: 990, balance: 8 }];
  expect(downsample(samples, 0, 1000, 4)).toEqual([5, 5, 5, 8]);
});

test("back-fills leading buckets that precede the first sample", () => {
  // Nothing known before the first row: flat at the earliest balance
  // rather than a fake climb from zero.
  const samples = [{ ts: 800, balance: 42 }];
  expect(downsample(samples, 0, 1000, 4)).toEqual([42, 42, 42, 42]);
});

test("always returns exactly the requested bucket count", () => {
  const samples = [{ ts: 500, balance: 1 }];
  expect(downsample(samples, 0, 1000, 24)).toHaveLength(24);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test -- gains`
Expected: FAIL — cannot resolve `./gains.js`.

- [ ] **Step 3: Implement the helper**

Create `apps/backend/src/state/gains.ts`:

```ts
import type { PointSample } from "../db/history.js";

/**
 * Reduces a change-only series to a fixed-length array of balances for a
 * sparkline.
 *
 * Buckets by *time*, not by row index. Snapshots are written only when the
 * balance changes, so rows are unevenly spaced: a claim burst can put five
 * rows in one minute while a quiet hour has none. Taking every Nth row
 * would stretch the burst across most of the line and collapse the quiet
 * hour to nothing -- the shape would misreport when the earning happened.
 *
 * Each bucket holds the last balance known at its end, so quiet buckets
 * render flat (the balance genuinely did not move) rather than as gaps.
 * Buckets before the first sample are back-filled with the earliest known
 * balance: we do not know the value then, and starting from zero would
 * draw a dramatic climb that never happened.
 */
export function downsample(
  samples: PointSample[],
  fromTs: number,
  toTs: number,
  buckets = 24,
): number[] {
  if (samples.length === 0) return [];

  const span = toTs - fromTs;
  const width = span / buckets;
  const out: number[] = [];
  let cursor = 0;
  let carried: number | null = null;

  for (let i = 0; i < buckets; i++) {
    const end = fromTs + width * (i + 1);
    while (cursor < samples.length && samples[cursor].ts <= end) {
      carried = samples[cursor].balance;
      cursor++;
    }
    out.push(carried ?? samples[0].balance);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test -- gains`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/state/gains.ts apps/backend/src/state/gains.test.ts
git commit -m "feat: add time-bucketed sparkline downsampling"
```

---

### Task 3: Attach gains and sparkline to StreamerState

**Files:**
- Modify: `apps/backend/src/state/service.ts`
- Test: `apps/backend/src/state/service.test.ts`

**Interfaces:**
- Consumes: `History.balanceAt`, `History.seriesSince` (Task 1); `downsample` (Task 2).
- Produces: `StreamerState` gains three fields — `gained24h: number | null`, `gainedStream: number | null`, `spark: number[]`. All three are computed in `doRefresh` before the change comparison.

- [ ] **Step 1: Write the failing tests**

Add to `apps/backend/src/state/service.test.ts`:

```ts
test("reports 24h gain against the balance in force a day ago", async () => {
  clock = 90_000_000;
  history.recordPoints("alpha", 1000, clock - 86_400_000);
  const { service } = make([alpha(1500)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].gained24h).toBe(500);
});

test("reports null 24h gain when there is no prior balance to compare", async () => {
  // A fresh install must not claim a confident "+0" it cannot know.
  const { service } = make([alpha(1500)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].gained24h).toBe(null);
});

test("anchors stream gain to the moment a streamer came online", async () => {
  const { service } = make([alpha(100, false), alpha(100, true), alpha(340, true)]);
  await service.refresh();                       // offline, no anchor
  await service.refresh();                       // false -> true: anchor at 100
  await service.refresh();                       // still live, now 340
  expect(service.snapshot().streamers[0].gainedStream).toBe(240);
});

test("reports null stream gain for an offline streamer", async () => {
  const { service } = make([alpha(100, false)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].gainedStream).toBe(null);
});

test("drops the stream anchor when a streamer goes offline", async () => {
  const { service } = make([alpha(100, false), alpha(100, true), alpha(500, false)]);
  await service.refresh();
  await service.refresh();
  await service.refresh();
  expect(service.snapshot().streamers[0].gainedStream).toBe(null);
});

test("attaches a sparkline series", async () => {
  clock = 90_000_000;
  history.recordPoints("alpha", 900, clock - 3_600_000);
  const { service } = make([alpha(1000)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].spark.length).toBeGreaterThan(0);
});

test("does not emit a change frame when only wall-clock time has passed", async () => {
  // Derived fields must not encode "now", or every refresh would wake
  // every SSE client with an identical payload.
  const { service } = make([alpha(100), alpha(100)]);
  await service.refresh();
  const changes = vi.fn();
  service.on("change", changes);
  clock += 60_000;
  await service.refresh();
  expect(changes).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/backend test -- service`
Expected: FAIL — `gained24h` is `undefined`.

- [ ] **Step 3: Implement the derivation**

In `apps/backend/src/state/service.ts`, extend the interface:

```ts
export interface StreamerState {
  username: string;
  channelId: string | null;
  displayName: string | null;
  points: number | null;
  isOnline: boolean | null;
  pointsEnabled: boolean | null;
  error?: string;
  /** Points gained over the last 24h; null when no prior balance is known. */
  gained24h: number | null;
  /** Points gained since this streamer came online; null when offline. */
  gainedStream: number | null;
  /** Downsampled 24h balances for the card sparkline. */
  spark: number[];
}
```

Add the import and the anchor field:

```ts
import { downsample } from "./gains.js";

const DAY_MS = 86_400_000;
```

```ts
  /**
   * Balance observed when each streamer was last seen going online.
   *
   * The anchor is the `isOnline` false->true transition this poller
   * observes, not an `events` row: the miner's event log records carry no
   * streamer identity (only `emoji` and `event`), so an online event
   * cannot be attributed to a channel without parsing log message text --
   * which the doorbell exists to avoid. The cost is that the anchor is
   * accurate to one refresh interval rather than to the second, which
   * rounds to nothing in a points-gained figure.
   */
  private streamAnchor = new Map<string, number>();
```

In `doRefresh`, replace the existing assignment and points-recording block (currently `apps/backend/src/state/service.ts:118-126`) with:

```ts
      const before = JSON.stringify(this.streamers);
      const previous = new Map(this.streamers.map((s) => [s.username, s]));
      this.lastUpdated = this.now();
      this.lastError = null;

      this.streamers = data.streamers.map((s) => {
        if (typeof s.points === "number") {
          this.deps.history.recordPoints(s.username, s.points, this.lastUpdated!);
        }

        const wasOnline = previous.get(s.username)?.isOnline ?? null;
        if (s.isOnline && wasOnline === false && typeof s.points === "number") {
          this.streamAnchor.set(s.username, s.points);
        }
        if (!s.isOnline) {
          this.streamAnchor.delete(s.username);
        }

        const dayAgo = this.lastUpdated! - DAY_MS;
        const past = this.deps.history.balanceAt(s.username, dayAgo);
        const anchor = this.streamAnchor.get(s.username);

        return {
          ...s,
          gained24h:
            past === null || typeof s.points !== "number" ? null : s.points - past,
          gainedStream:
            anchor === undefined || typeof s.points !== "number"
              ? null
              : s.points - anchor,
          spark: downsample(
            this.deps.history.seriesSince(s.username, dayAgo),
            dayAgo,
            this.lastUpdated!,
          ),
        };
      });

      if (before !== JSON.stringify(this.streamers)) {
        this.emit("change", this.snapshot());
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test`
Expected: PASS — all backend tests, including the pre-existing service and server suites.

> If `server.test.ts` fixtures fail to typecheck because they construct
> `StreamerState` literals without the new fields, add
> `gained24h: null, gainedStream: null, spark: []` to those fixtures.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/state/service.ts apps/backend/src/state/service.test.ts apps/backend/src/http/server.test.ts
git commit -m "feat: derive point gains and sparkline series per streamer"
```

---

### Task 4: Serve recent events to the dashboard

**Files:**
- Modify: `apps/backend/src/http/server.ts:242`
- Test: `apps/backend/src/http/server.test.ts`

**Interfaces:**
- Consumes: `History.recentEvents` (existing).
- Produces: `GET /api/events` → `{ events: { ts: number; type: string }[] }`, newest first, capped at 20.

Rationale: the dashboard needs events without naming a streamer, and `/api/history` requires a `streamer` plus a range. A separate route keeps the feed independent of the charting route rather than overloading it.

- [ ] **Step 1: Write the failing test**

Add to `apps/backend/src/http/server.test.ts`:

```ts
test("GET /api/events returns recent events newest first", async () => {
  ctx.history.recordEvent("STREAMER_ONLINE", 1000);
  ctx.history.recordEvent("GAIN_FOR_CLAIM", 2000);
  const response = await ctx.app.inject({
    method: "GET", url: "/api/events", cookies: auth(),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().events).toEqual([
    { ts: 2000, type: "GAIN_FOR_CLAIM" },
    { ts: 1000, type: "STREAMER_ONLINE" },
  ]);
});
```

Also add `["GET", "/api/events"]` to the authentication table at `apps/backend/src/http/server.test.ts:325` so the route is covered by the existing "requires auth" sweep.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app/backend test -- server`
Expected: FAIL — 404, `events` is undefined.

- [ ] **Step 3: Add the route**

In `apps/backend/src/http/server.ts`, directly after the `/api/streamers` route:

```ts
    instance.get("/api/events", async () => ({
      events: deps.history.recentEvents(20),
    }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/backend test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/http/server.ts apps/backend/src/http/server.test.ts
git commit -m "feat: expose recent miner events over HTTP"
```

---

### Task 5: Sparkline component

**Files:**
- Create: `apps/frontend/src/components/Sparkline.tsx`
- Test: `apps/frontend/src/components/Sparkline.test.tsx`

**Interfaces:**
- Produces: `<Sparkline values={number[]} width?={number} height?={number} />`. Renders `null` for fewer than 2 values.

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/components/Sparkline.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Sparkline } from "./Sparkline.js";

test("renders nothing when there is no shape to draw", () => {
  const { container } = render(<Sparkline values={[]} />);
  expect(container.querySelector("svg")).toBeNull();
});

test("renders nothing for a single point", () => {
  const { container } = render(<Sparkline values={[5]} />);
  expect(container.querySelector("svg")).toBeNull();
});

test("draws a polyline through the values", () => {
  const { container } = render(<Sparkline values={[1, 2, 3]} />);
  expect(container.querySelector("polyline")).not.toBeNull();
});

test("draws a flat line when every value is identical", () => {
  // A zero-height range must not divide by zero and blank the card.
  const { container } = render(<Sparkline values={[7, 7, 7]} />);
  const points = container.querySelector("polyline")?.getAttribute("points") ?? "";
  const ys = points.split(" ").map((p) => Number(p.split(",")[1]));
  expect(new Set(ys).size).toBe(1);
  expect(ys.every(Number.isFinite)).toBe(true);
});

test("is hidden from assistive tech, since the numbers beside it carry the meaning", () => {
  const { container } = render(<Sparkline values={[1, 2, 3]} />);
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/frontend test -- Sparkline`
Expected: FAIL — cannot resolve `./Sparkline.js`.

- [ ] **Step 3: Implement the component**

Create `apps/frontend/src/components/Sparkline.tsx`:

```tsx
interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
}

/**
 * A bare trend line: no axes, no ticks, no interaction.
 *
 * Deliberately not a chart. It answers "is this climbing or flat?" at a
 * glance, next to the exact numbers that answer "by how much". Hidden from
 * assistive tech because it carries no information the adjacent gain
 * figures do not already state precisely.
 */
export function Sparkline({ values, width = 88, height = 24 }: SparklineProps) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series has zero range; dividing by it would yield NaN
  // coordinates and drop the line entirely. Pin it to the midline instead.
  const range = max - min || 1;
  const stepX = width / (values.length - 1);

  const points = values
    .map((value, i) => {
      const x = i * stepX;
      const y = max === min ? height / 2 : height - ((value - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} aria-hidden="true" focusable="false">
      <polyline
        points={points}
        fill="none"
        stroke="var(--mantine-color-teal-5)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/frontend test -- Sparkline`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/Sparkline.tsx apps/frontend/src/components/Sparkline.test.tsx
git commit -m "feat: add sparkline component for point trends"
```

---

### Task 6: StreamerCard component

**Files:**
- Create: `apps/frontend/src/components/StreamerCard.tsx`
- Test: `apps/frontend/src/components/StreamerCard.test.tsx`
- Modify: `apps/frontend/src/api/useLiveState.ts` (mirror the new fields)

**Interfaces:**
- Consumes: `StreamerState` from `../api/useLiveState.js`; `Sparkline` (Task 5).
- Produces: `<StreamerCard streamer={StreamerState} />`.

- [ ] **Step 1: Mirror the backend type**

In `apps/frontend/src/api/useLiveState.ts`, add to the `StreamerState` interface:

```ts
  gained24h: number | null;
  gainedStream: number | null;
  spark: number[];
```

- [ ] **Step 2: Write the failing tests**

Create `apps/frontend/src/components/StreamerCard.test.tsx`:

```tsx
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { StreamerCard } from "./StreamerCard.js";
import type { StreamerState } from "../api/useLiveState.js";

const base: StreamerState = {
  username: "alpha", displayName: "Alpha", channelId: "1",
  points: 1000, isOnline: true, pointsEnabled: true,
  gained24h: 250, gainedStream: 40, spark: [900, 950, 1000],
};

const view = (streamer: Partial<StreamerState> = {}) =>
  render(
    <MantineProvider><StreamerCard streamer={{ ...base, ...streamer }} /></MantineProvider>,
  );

test("shows the exact balance, not an abbreviated one", () => {
  view({ points: 1234567 });
  expect(screen.getByText("1,234,567")).toBeInTheDocument();
});

test("shows both gains for a live streamer", () => {
  view();
  expect(screen.getByTestId("gain-stream")).toHaveTextContent("+40");
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("+250");
});

test("omits stream gain when the streamer is offline", () => {
  view({ isOnline: false, gainedStream: null });
  expect(screen.queryByTestId("gain-stream")).not.toBeInTheDocument();
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("+250");
});

test("distinguishes an unknown gain from a genuine zero", () => {
  view({ gained24h: null });
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("—");
  view({ gained24h: 0 });
  expect(screen.getAllByTestId("gain-24h").at(-1)).toHaveTextContent("0");
});

test("signs a negative gain rather than showing a bare number", () => {
  view({ gained24h: -30 });
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("-30");
});

test("warns when channel points are disabled, since the balance is frozen", () => {
  view({ pointsEnabled: false });
  expect(screen.getByTestId("points-disabled")).toBeInTheDocument();
});

test("surfaces a per-streamer error", () => {
  view({ error: "channel lookup failed" });
  expect(screen.getByRole("alert")).toHaveTextContent("channel lookup failed");
});

test("shows a placeholder when the balance is unknown", () => {
  view({ points: null });
  expect(screen.getByTestId("balance")).toHaveTextContent("—");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @app/frontend test -- StreamerCard`
Expected: FAIL — cannot resolve `./StreamerCard.js`.

- [ ] **Step 4: Implement the component**

Create `apps/frontend/src/components/StreamerCard.tsx`:

```tsx
import { Badge, Card, Group, Stack, Text, Tooltip } from "@mantine/core";
import { Sparkline } from "./Sparkline.js";
import type { StreamerState } from "../api/useLiveState.js";

const nf = new Intl.NumberFormat("en-US");

/**
 * Renders a gain.
 *
 * `null` means "we have no earlier balance to compare against" -- a fresh
 * install, or a streamer added minutes ago -- and must not render as "+0",
 * which is a confident claim that nothing was earned.
 */
function Gain({ value, label, testId }: { value: number | null; label: string; testId: string }) {
  if (value === null) {
    return (
      <Text size="xs" c="dimmed" data-testid={testId}>— {label}</Text>
    );
  }
  const sign = value > 0 ? "+" : "";
  return (
    <Text size="xs" c={value > 0 ? "teal" : value < 0 ? "red" : "dimmed"} data-testid={testId}>
      {sign}{nf.format(value)} {label}
    </Text>
  );
}

export function StreamerCard({ streamer: s }: { streamer: StreamerState }) {
  return (
    <Card withBorder data-testid={`streamer-${s.username}`}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600} truncate>{s.displayName ?? s.username}</Text>
          {s.pointsEnabled === false && (
            <Tooltip label="Channel points are disabled for this channel, so the balance cannot move.">
              <Badge color="yellow" variant="light" size="sm" data-testid="points-disabled">
                no points
              </Badge>
            </Tooltip>
          )}
        </Group>

        <Group justify="space-between" align="flex-end" wrap="nowrap">
          <Text size="lg" data-testid="balance">
            {s.points === null ? "—" : nf.format(s.points)}
          </Text>
          <Sparkline values={s.spark} />
        </Group>

        <Group gap="sm">
          {s.isOnline && s.gainedStream !== null && (
            <Gain value={s.gainedStream} label="stream" testId="gain-stream" />
          )}
          <Gain value={s.gained24h} label="24h" testId="gain-24h" />
        </Group>

        {s.error && (
          <Text role="alert" size="xs" c="red">{s.error}</Text>
        )}
      </Stack>
    </Card>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @app/frontend test -- StreamerCard`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/components/StreamerCard.tsx apps/frontend/src/components/StreamerCard.test.tsx apps/frontend/src/api/useLiveState.ts
git commit -m "feat: add streamer card with gains, sparkline and health badges"
```

---

### Task 7: Events feed component

**Files:**
- Create: `apps/frontend/src/components/EventsFeed.tsx`
- Test: `apps/frontend/src/components/EventsFeed.test.tsx`

**Interfaces:**
- Consumes: `GET /api/events` (Task 4) via `api.get`.
- Produces: `<EventsFeed />` — self-fetching, renders nothing on failure.

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/components/EventsFeed.test.tsx`:

```tsx
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EventsFeed } from "./EventsFeed.js";

function stub(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok, status: ok ? 200 : 500, json: async () => body,
  })));
}

afterEach(() => vi.unstubAllGlobals());

const view = () => render(<MantineProvider><EventsFeed /></MantineProvider>);

test("renders events as readable labels rather than raw enum names", async () => {
  stub({ events: [{ ts: Date.now(), type: "STREAMER_ONLINE" }] });
  view();
  expect(await screen.findByText(/streamer online/i)).toBeInTheDocument();
});

test("says so when nothing has happened yet", async () => {
  stub({ events: [] });
  view();
  expect(await screen.findByText(/no activity yet/i)).toBeInTheDocument();
});

test("stays silent when the feed cannot be loaded", async () => {
  // The feed is ancillary; a failure must not put an error banner on the
  // dashboard beside perfectly good numbers.
  stub({ error: "boom" }, false);
  const { container } = view();
  await new Promise((r) => setTimeout(r, 0));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/frontend test -- EventsFeed`
Expected: FAIL — cannot resolve `./EventsFeed.js`.

- [ ] **Step 3: Implement the component**

Create `apps/frontend/src/components/EventsFeed.tsx`:

```tsx
import { Card, Group, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

interface MinerEvent { ts: number; type: string }

/**
 * Events carry a type and a time and nothing else -- the miner's log
 * records have no streamer identity to forward, so rows cannot name a
 * channel. See the plan's Global Constraints.
 */
function label(type: string): string {
  return type.toLowerCase().replace(/_/g, " ");
}

function ago(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function EventsFeed() {
  const [events, setEvents] = useState<MinerEvent[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.get<{ events: MinerEvent[] }>("/api/events")
      .then((payload) => { if (alive) setEvents(payload.events); })
      // Ancillary panel: a failure here must not raise an alert next to
      // numbers that loaded fine. Stay unrendered instead.
      .catch(() => { if (alive) setEvents(null); });
    return () => { alive = false; };
  }, []);

  if (events === null) return null;

  const now = Date.now();
  return (
    <Stack gap="xs">
      <Title order={4}>Recent activity</Title>
      <Card withBorder>
        {events.length === 0 ? (
          <Text size="sm" c="dimmed">No activity yet.</Text>
        ) : (
          <Stack gap={4}>
            {events.map((event) => (
              <Group key={`${event.ts}-${event.type}`} justify="space-between">
                <Text size="sm">{label(event.type)}</Text>
                <Text size="xs" c="dimmed">{ago(event.ts, now)}</Text>
              </Group>
            ))}
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @app/frontend test -- EventsFeed`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/EventsFeed.tsx apps/frontend/src/components/EventsFeed.test.tsx
git commit -m "feat: add recent activity feed"
```

---

### Task 8: Compose the dashboard

**Files:**
- Modify: `apps/frontend/src/routes/Dashboard.tsx`
- Test: `apps/frontend/src/routes/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `StreamerCard` (Task 6), `EventsFeed` (Task 7).

- [ ] **Step 1: Update the fixture and add tests**

In `apps/frontend/src/routes/Dashboard.test.tsx`, extend both fixture streamers with the new fields:

```tsx
    { username: "alpha", displayName: "Alpha", points: 123456, isOnline: true,
      channelId: "1", pointsEnabled: true,
      gained24h: 500, gainedStream: 120, spark: [122000, 123000, 123456] },
    { username: "beta", displayName: "Beta", points: 20, isOnline: false,
      channelId: "2", pointsEnabled: true,
      gained24h: 0, gainedStream: null, spark: [20, 20, 20] },
```

The existing `live-alpha` test id no longer exists; update that test and add coverage:

```tsx
test("shows who is live", async () => {
  view();
  expect(await screen.findByTestId("streamer-alpha")).toBeInTheDocument();
  expect(screen.getByTestId("live-heading")).toHaveTextContent("Live now (1)");
});

test("shows gains on the card so the balance has a reference point", async () => {
  view();
  expect(await screen.findByTestId("streamer-alpha")).toHaveTextContent("+120");
  expect(screen.getByTestId("streamer-alpha")).toHaveTextContent("+500");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app/frontend test -- Dashboard`
Expected: FAIL — no `streamer-alpha` test id.

- [ ] **Step 3: Rewrite the grids**

In `apps/frontend/src/routes/Dashboard.tsx`, replace both `SimpleGrid` blocks and their card bodies with `StreamerCard`, and mount the feed. Remove the now-unused `fmt` helper and the `Card`/`Group`/`Text` imports that are no longer referenced:

```tsx
      <Title order={4} data-testid="live-heading">Live now ({live.length})</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {live.map((s) => <StreamerCard key={s.username} streamer={s} />)}
      </SimpleGrid>

      <Title order={4}>Offline</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {others.map((s) => <StreamerCard key={s.username} streamer={s} />)}
      </SimpleGrid>

      <EventsFeed />
```

Add the imports:

```tsx
import { EventsFeed } from "../components/EventsFeed.js";
import { StreamerCard } from "../components/StreamerCard.js";
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm --filter @app/frontend test && pnpm --filter @app/backend test`
Expected: PASS on both.

- [ ] **Step 5: Typecheck both apps**

Run: `pnpm --filter @app/frontend build && pnpm --filter @app/backend build`
Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/routes/Dashboard.tsx apps/frontend/src/routes/Dashboard.test.tsx
git commit -m "feat: show gains, sparklines and recent activity on the dashboard"
```

---

### Task 9: Verify against the running app

**Files:** none — this is a manual verification gate.

- [ ] **Step 1: Keep the existing database**

Do **not** delete `.devdata/history.db`. This plan changes no schema, and the
file holds ~19 real snapshots across two streamers plus 132 events -- genuine
uneven, climbing data that is exactly what verification needs. Deleting it
would leave every gain rendering `—` with nothing to check.

Note `.devdata/` also contains `config.json` and `cookies/` (the Twitch
session); never `rm -rf` the directory.

To confirm what is there:

```bash
cd apps/backend && node -e "
const D=require('better-sqlite3');
const db=new D('../../.devdata/history.db',{readonly:true});
console.log(db.prepare('SELECT streamer, COUNT(*) n, MAX(balance) hi FROM point_snapshots GROUP BY streamer').all());
"
```

- [ ] **Step 2: Run the app**

Use the `run` skill, or the project's dev script. Sign in and open the dashboard.

- [ ] **Step 3: Confirm each behaviour**

- Cards render name, balance, and a `— 24h` gain on a fresh database (**not** `+0`).
- After two refresh cycles with a live streamer earning, `+N stream` appears.
- A streamer with `pointsEnabled: false` shows the "no points" badge.
- The recent activity list populates as doorbell events arrive.
- Leave it running ~2 minutes: the sparkline stays flat and the card does not flicker, confirming no spurious `change` frames.

- [ ] **Step 4: Commit any fixes**

If verification turns up defects, fix them with a test that reproduces the defect first.

---

## Self-Review

**Spec coverage.** The design doc's `point_snapshots` store is now read (it was written-only before). The spec's `events(ts, type, streamer_id?)` optional streamer column is deliberately not implemented — the miner provides no streamer identity on event records, documented in Global Constraints and in Task 3's anchor comment. `/api/history` is untouched and remains available for the eventual chart page.

**Placeholder scan.** No TBDs. Every code step carries the actual code; every test step carries the actual assertions.

**Type consistency.** `gained24h`, `gainedStream`, `spark` are declared in Task 3 and consumed under those exact names in Tasks 6 and 8. `balanceAt`/`seriesSince` (Task 1) are called with matching signatures in Task 3. `downsample(samples, fromTs, toTs, buckets?)` (Task 2) matches its Task 3 call site. `Sparkline` takes `values` in both Task 5 and Task 6.

**Known follow-ups, deliberately out of scope.** The events feed does not live-update (it fetches once on mount); wiring it to SSE is a separate change. The sparkline has no hover detail — that belongs to the chart page you have deferred.
