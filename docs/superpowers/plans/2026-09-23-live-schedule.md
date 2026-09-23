# Live-Schedule Heatmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekday × hour grid in the streamer detail dialog that shows when a channel is usually live, based on the last 12 weeks of observed streams.

**Architecture:** A new backend route returns the channel's raw live spans for the observed window: the last 12 weeks, starting no earlier than our first sighting of the channel. The browser buckets those spans into 168 hour-of-week cells in *its own* timezone. Each cell counts how many of its own occurrences in the window the channel was live for. A `LiveSchedule` component renders the grid with a validated one-hue purple ramp, and the ramp lives in a shared module so the Insights calendar can reuse it.

**Tech Stack:** Fastify + better-sqlite3 (backend), React 19 + Mantine 9.6 (`Tooltip`), CSS modules, Vitest, Playwright for the browser check.

**Spec:** `docs/superpowers/specs/2026-09-23-insights-and-palette-design.md`, section "Slice 3: Live-schedule heatmap" and the `GET /api/streamers/:login/schedule` endpoint. This is slice 3 of 4; slices 1 and 2 are merged.

## Global Constraints

- **Never commit without the user's go-ahead.** Show the task's diffstat and wait, unless the user has picked a commit rhythm for this run. Commit on `main` with no branch. Use conventional-commit subjects with an explanatory body, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Comments** describe the current code. Don't narrate rejected alternatives, but keep any note that stops a future change from breaking something.
- **The window is 12 weeks, starting at the later of 12 weeks ago and the channel's `first_seen_ts`.** A channel never seen has an empty window (`since === now`).
- **Buckets are in the browser's timezone, Monday first.** Index `0` is Monday 00:00–01:00, and `167` is Sunday 23:00–24:00.
- **A cell's value is `live / of`.** `of` is how many complete occurrences of that hour fall inside `[since, now]`, and `live` is how many of those overlapped a live span.
- **Under 2 weeks of observation, show "Needs a couple of weeks of tracking" instead of the grid.**
- **Colours** (validated with the dataviz skill's ordinal check against the dialog surface `#18181B`: monotone lightness, faintest step 2.13:1, one hue): data steps `#5E37A0`, `#7A40D5`, `#9A5BFF`, `#C4A3FF`. Hours that were observed but never live use `#26262C`, which is not a data step. The grid has 2px gaps between cells.
- **Tooltip wording:** "Tuesdays 20:00–21:00 · live 9 of 12 weeks", with `week` singular when `of === 1`.
- **Tests build dates in local time.** Vitest has no timezone pin and the container runs Europe/Berlin, so fixtures use `new Date(2026, 8, d, h)` and avoid DST changeover dates.
- **Backend tests:** `pnpm --filter @app/backend exec vitest run <path>`. **Frontend tests:** `pnpm --filter @app/frontend exec vitest run <path>`. Typecheck the frontend with `pnpm --filter @app/frontend exec tsc -b` and the backend with `pnpm run build:backend`.
- `verbatimModuleSyntax` is on, so type-only imports use `import type`.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `apps/backend/src/http/server.ts` | modify | `GET /api/streamers/:login/schedule` |
| `apps/backend/src/http/server.test.ts` | modify | Route tests |
| `apps/frontend/src/lib/heatRamp.ts` | create | The shared purple ramp and `heatColor(fraction)` |
| `apps/frontend/src/lib/liveSchedule.ts` | create | `hourOfWeek`, `bucketSchedule` |
| `apps/frontend/src/api/useLiveSchedule.ts` | create | Fetches the schedule once per dialog open and checks its shape |
| `apps/frontend/src/components/LiveSchedule.tsx` + `.module.css` | create | Heading, legend, states, and the 7 × 24 grid |
| `apps/frontend/src/components/StreamerDetailModal.tsx` | modify | Fetches the schedule and renders it below the coverage timeline |

---

### Task 1: The schedule endpoint

**Files:**
- Modify: `apps/backend/src/http/server.ts` (add a route directly after the `/api/history` route)
- Modify: `apps/backend/src/http/server.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `usernameSchema` (already imported in `server.ts`), `deps.history.streamerSpans(login, fromTs): Span[]`, `deps.streamers?.firstSeen(login): number | null`, and `clip(spans, from, to)` (already imported from `../state/spans.js`).
- Produces: `GET /api/streamers/:login/schedule`, which returns `{ since: number; now: number; spans: Array<{ start: number; end: number }> }`, or 400 `{ error }` for an invalid login. `spans` are oldest first, clipped to `[since, now]`, and an open session ends at `now`.

- [ ] **Step 1: Write the failing route tests**

In `apps/backend/src/http/server.test.ts`, make sure `describe` is in the vitest import (`import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";`), then append:

```ts
describe("GET /api/streamers/:login/schedule", () => {
  const HOUR = 3_600_000;
  const WEEK = 7 * 24 * HOUR;
  const NOW = 100 * WEEK;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const get = (login: string) => ctx.app.inject({
    method: "GET", url: `/api/streamers/${login}/schedule`, cookies: auth(),
  });

  /** A finished stream. Sessions close at the last point snapshot, so one
   *  is written at `end`; call these in chronological order. */
  const stream = (id: string, start: number, end: number) => {
    ctx.history.openStreamerSession("alpha", id, start, null);
    ctx.history.recordPoints("alpha", end, end);
    ctx.history.closeStreamerSessionsExcept("alpha", null, end);
  };

  test("refuses a login that is not a Twitch username", async () => {
    expect((await get("not%20valid")).statusCode).toBe(400);
  });

  test("a channel never seen has an empty window, not twelve weeks of zeros", async () => {
    expect((await get("alpha")).json()).toEqual({ since: NOW, now: NOW, spans: [] });
  });

  test("starts at the first sighting and clips streams to the window", async () => {
    ctx.streamers.see("alpha", NOW - 3 * WEEK);
    stream("before", NOW - 4 * WEEK, NOW - 4 * WEEK + HOUR);
    stream("straddles", NOW - 3 * WEEK - HOUR, NOW - 3 * WEEK + 2 * HOUR);
    stream("inside", NOW - 2 * WEEK, NOW - 2 * WEEK + 3 * HOUR);
    ctx.history.openStreamerSession("alpha", "live", NOW - HOUR, null);

    const body = (await get("alpha")).json();
    expect(body.since).toBe(NOW - 3 * WEEK);
    expect(body.now).toBe(NOW);
    expect(body.spans).toEqual([
      { start: NOW - 3 * WEEK, end: NOW - 3 * WEEK + 2 * HOUR },
      { start: NOW - 2 * WEEK, end: NOW - 2 * WEEK + 3 * HOUR },
      // Still live: read as running until now.
      { start: NOW - HOUR, end: NOW },
    ]);
  });

  test("looks back no further than twelve weeks", async () => {
    ctx.streamers.see("alpha", NOW - 20 * WEEK);
    expect((await get("alpha")).json().since).toBe(NOW - 12 * WEEK);
  });
});
```

Run: `pnpm --filter @app/backend exec vitest run src/http/server.test.ts -t schedule`
Expected: FAIL. The route doesn't exist, so the requests return 404.

- [ ] **Step 2: Implement the route**

In `apps/backend/src/http/server.ts`, directly after the closing `});` of the `instance.get("/api/history", …)` handler, add:

```ts
    // The live-schedule grid's data: when this channel was live over the
    // weeks we have been watching it. Raw spans, not buckets -- the grid
    // is laid out in the viewer's timezone, which only the browser knows.
    instance.get("/api/streamers/:login/schedule", async (request, reply) => {
      const login = usernameSchema.safeParse((request.params as { login?: unknown }).login);
      if (!login.success) {
        return reply.code(400).send({ error: "login must be a valid Twitch username" });
      }
      const now = Date.now();
      // Never before our first sighting: before it, "not live" would only
      // mean "not watched". A channel never seen has no window at all,
      // rather than twelve weeks that read as never live.
      const firstSeen = deps.streamers?.firstSeen(login.data) ?? null;
      const since = firstSeen === null
        ? now
        : Math.max(now - SCHEDULE_WEEKS * WEEK_MS, firstSeen);
      return {
        since,
        now,
        spans: clip(deps.history.streamerSpans(login.data, since), since, now),
      };
    });
```

Near the top of the file, after the imports, add:

```ts
/** How far back the live-schedule grid looks. */
const SCHEDULE_WEEKS = 12;
const WEEK_MS = 7 * 86_400_000;
```

If a `WEEK_MS` constant already exists in `server.ts`, reuse it instead (`grep -n "WEEK_MS" apps/backend/src/http/server.ts`).

`clip` returns `Span[]` with `end: number | null`, but every clipped span has a numeric end because `clip` resolves open spans against `now`. The JSON shape is therefore `{ start, end }` with numbers, and no cast is needed.

- [ ] **Step 3: Run the tests and the backend build**

Run: `pnpm --filter @app/backend exec vitest run src/http/server.test.ts`
Expected: PASS, the whole file.

Run: `pnpm run build:backend`
Expected: exit 0.

- [ ] **Step 4: Show the diffstat, then commit once approved**

```bash
git add apps/backend/src/http/server.ts apps/backend/src/http/server.test.ts
git commit -m "feat(api): report when a channel was live over the last twelve weeks

GET /api/streamers/:login/schedule returns the channel's live spans
since the later of twelve weeks ago and our first sighting of it,
clipped to that window, with an open stream running to now. Raw spans
rather than buckets: the grid is laid out in the viewer's timezone,
which only the browser knows. A channel never seen has an empty window.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bucketing and the colour ramp

**Files:**
- Create: `apps/frontend/src/lib/heatRamp.ts`
- Create: `apps/frontend/src/lib/heatRamp.test.ts`
- Create: `apps/frontend/src/lib/liveSchedule.ts`
- Create: `apps/frontend/src/lib/liveSchedule.test.ts`

**Interfaces:**
- Produces, from `lib/heatRamp.ts`:
  - `const HEAT_EMPTY = "#26262C"`
  - `const HEAT_STEPS: readonly ["#5E37A0", "#7A40D5", "#9A5BFF", "#C4A3FF"]`
  - `function heatColor(fraction: number): string`, which maps 0 to `HEAT_EMPTY`, (0, .25] to step 0, (.25, .5] to step 1, (.5, .75] to step 2 and (.75, 1] to step 3
- Produces, from `lib/liveSchedule.ts`:
  - `const HOURS_PER_WEEK = 168`
  - `interface ScheduleCell { live: number; of: number }`
  - `interface Schedule { cells: ScheduleCell[]; weeks: number }`
  - `function hourOfWeek(date: Date): number`, Monday-first and local
  - `function bucketSchedule(spans: ReadonlyArray<{ start: number; end: number }>, since: number, now: number): Schedule`

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/lib/heatRamp.test.ts`:

```ts
import { expect, test } from "vitest";
import { HEAT_EMPTY, HEAT_STEPS, heatColor } from "./heatRamp.js";

test("never is the empty colour, not the faintest step", () => {
  expect(heatColor(0)).toBe(HEAT_EMPTY);
});

test("fractions fill four equal bands, faint to bright", () => {
  expect(heatColor(0.1)).toBe(HEAT_STEPS[0]);
  expect(heatColor(0.25)).toBe(HEAT_STEPS[0]);
  expect(heatColor(0.26)).toBe(HEAT_STEPS[1]);
  expect(heatColor(0.5)).toBe(HEAT_STEPS[1]);
  expect(heatColor(0.75)).toBe(HEAT_STEPS[2]);
  expect(heatColor(0.9)).toBe(HEAT_STEPS[3]);
  expect(heatColor(1)).toBe(HEAT_STEPS[3]);
});
```

Create `apps/frontend/src/lib/liveSchedule.test.ts`:

```ts
import { expect, test } from "vitest";
import { bucketSchedule, hourOfWeek, HOURS_PER_WEEK } from "./liveSchedule.js";

// Local time on purpose: the grid is laid out in the viewer's timezone.
// September 2026 has no DST change; the 7th, 14th and 21st are Mondays.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).getTime();
const cell = (weekday: number, hour: number) => weekday * 24 + hour; // 0 = Monday

const SINCE = at(7, 0);
const NOW = at(21, 0); // exactly two weeks

test("hour of week is Monday-first", () => {
  expect(hourOfWeek(new Date(at(7, 0)))).toBe(0);
  expect(hourOfWeek(new Date(at(8, 20, 30)))).toBe(cell(1, 20));
  expect(hourOfWeek(new Date(at(13, 23)))).toBe(HOURS_PER_WEEK - 1);
});

test("every hour of a two-week window is observed twice", () => {
  const { cells, weeks } = bucketSchedule([], SINCE, NOW);
  expect(cells).toHaveLength(HOURS_PER_WEEK);
  expect(cells.every((c) => c.of === 2 && c.live === 0)).toBe(true);
  expect(weeks).toBe(2);
});

test("a stream marks each hour it touches", () => {
  const { cells } = bucketSchedule([{ start: at(8, 20, 30), end: at(8, 21, 10) }], SINCE, NOW);
  expect(cells[cell(1, 19)]).toEqual({ live: 0, of: 2 });
  expect(cells[cell(1, 20)]).toEqual({ live: 1, of: 2 });
  expect(cells[cell(1, 21)]).toEqual({ live: 1, of: 2 });
  expect(cells[cell(1, 22)]).toEqual({ live: 0, of: 2 });
});

test("a stream across midnight and the week boundary lands on both days", () => {
  // Sunday 23:30 to Monday 00:30.
  const { cells } = bucketSchedule([{ start: at(13, 23, 30), end: at(14, 0, 30) }], SINCE, NOW);
  expect(cells[cell(6, 23)].live).toBe(1);
  expect(cells[cell(0, 0)].live).toBe(1);
});

test("the same hour in both weeks counts twice; two streams in one hour count once", () => {
  const { cells } = bucketSchedule([
    { start: at(8, 20, 0), end: at(8, 20, 10) },
    { start: at(8, 20, 40), end: at(8, 20, 50) },
    { start: at(15, 20, 5), end: at(15, 20, 55) },
  ], SINCE, NOW);
  expect(cells[cell(1, 20)]).toEqual({ live: 2, of: 2 });
});

test("only whole hours inside the window are observed", () => {
  // Wednesday 12:15: the 12:00 hour that day is only partly observed.
  const { cells, weeks } = bucketSchedule([], at(9, 12, 15), NOW);
  expect(cells[cell(2, 12)].of).toBe(1); // only the 16th
  expect(cells[cell(2, 13)].of).toBe(2); // the 9th and the 16th
  expect(cells[cell(0, 0)].of).toBe(1); // the 14th; the 21st has not finished
  expect(weeks).toBeCloseTo((NOW - at(9, 12, 15)) / (7 * 86_400_000));
});

test("an empty window observes nothing", () => {
  const { cells, weeks } = bucketSchedule([], NOW, NOW);
  expect(cells.every((c) => c.of === 0)).toBe(true);
  expect(weeks).toBe(0);
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/lib/heatRamp.test.ts src/lib/liveSchedule.test.ts`
Expected: FAIL, because neither module can be resolved.

- [ ] **Step 2: Implement the ramp**

Create `apps/frontend/src/lib/heatRamp.ts`:

```ts
/**
 * The heatmaps' shared colour scale: one hue, faint to bright.
 *
 * Checked with the dataviz skill's ordinal validator against the dark
 * dialog surface (#18181B): lightness rises monotonically with visible
 * gaps between steps, the faintest step clears 2:1 against the surface,
 * and the hue spread is 4°. Re-run it before changing a value.
 */
export const HEAT_STEPS = ["#5E37A0", "#7A40D5", "#9A5BFF", "#C4A3FF"] as const;

/**
 * A cell with nothing in it: observed, and zero. Not a data step, so a
 * "never" cannot be mistaken for the faintest "sometimes".
 */
export const HEAT_EMPTY = "#26262C";

/** The colour for a 0..1 share, in four equal bands above zero. */
export function heatColor(fraction: number): string {
  if (fraction <= 0) return HEAT_EMPTY;
  const step = Math.min(HEAT_STEPS.length, Math.ceil(fraction * HEAT_STEPS.length)) - 1;
  return HEAT_STEPS[step];
}
```

- [ ] **Step 3: Implement the bucketing**

Create `apps/frontend/src/lib/liveSchedule.ts`:

```ts
export const HOURS_PER_WEEK = 168;
const WEEK_MS = 7 * 86_400_000;

/** One hour of the week, across the observed window. */
export interface ScheduleCell {
  /** Occurrences of this hour in which the channel was live. */
  live: number;
  /** Occurrences of this hour that fell wholly inside the window. */
  of: number;
}

export interface Schedule {
  /** Monday 00:00 first, local time. */
  cells: ScheduleCell[];
  /** How long the window is, in weeks. */
  weeks: number;
}

/** A local time's hour of the week, Monday first: 0 is Monday 00:00. */
export function hourOfWeek(date: Date): number {
  return ((date.getDay() + 6) % 7) * 24 + date.getHours();
}

/**
 * Buckets live spans into hours of the week, in the browser's timezone.
 *
 * Each cell counts its own occurrences in the window rather than dividing
 * by a global week count: in a window of two and a half weeks some hours
 * occurred three times and others twice, and scoring both out of the same
 * number would misreport one of them. Only whole hours inside the window
 * are counted, so an hour we watched ten minutes of is not scored as a
 * full observation.
 *
 * Hours are stepped with the Date constructor rather than by adding
 * 3,600,000, so a DST change skips or repeats a local hour the way the
 * clock does.
 */
export function bucketSchedule(
  spans: ReadonlyArray<{ start: number; end: number }>,
  since: number,
  now: number,
): Schedule {
  const cells = Array.from({ length: HOURS_PER_WEEK }, () => ({ live: 0, of: 0 }));

  let hour = new Date(since);
  hour.setMinutes(0, 0, 0);
  if (hour.getTime() < since) hour.setHours(hour.getHours() + 1);

  for (;;) {
    const next = new Date(
      hour.getFullYear(), hour.getMonth(), hour.getDate(), hour.getHours() + 1,
    );
    if (next.getTime() > now) break;
    const start = hour.getTime();
    const end = next.getTime();
    const cell = cells[hourOfWeek(hour)];
    cell.of += 1;
    if (spans.some((s) => s.start < end && s.end > start)) cell.live += 1;
    hour = next;
  }

  return { cells, weeks: Math.max(0, now - since) / WEEK_MS };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @app/frontend exec vitest run src/lib/heatRamp.test.ts src/lib/liveSchedule.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Show the diffstat, then commit once approved**

```bash
git add apps/frontend/src/lib/heatRamp.ts apps/frontend/src/lib/heatRamp.test.ts \
  apps/frontend/src/lib/liveSchedule.ts apps/frontend/src/lib/liveSchedule.test.ts
git commit -m "feat(ui): bucket live spans into hours of the week

bucketSchedule scores each hour of the week, in the browser's timezone,
by how many of its own occurrences in the window the channel was live
for, counting only whole hours inside the window. The heatmaps share a
one-hue purple ramp validated against the dark surface, with a neutral
colour for zero so never is not read as rarely.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The grid in the detail dialog

**Files:**
- Create: `apps/frontend/src/api/useLiveSchedule.ts`
- Create: `apps/frontend/src/components/LiveSchedule.tsx`
- Create: `apps/frontend/src/components/LiveSchedule.module.css`
- Create: `apps/frontend/src/components/LiveSchedule.test.tsx`
- Modify: `apps/frontend/src/components/StreamerDetailModal.tsx`
- Modify: `apps/frontend/src/components/StreamerDetailModal.test.tsx`

**Interfaces:**
- Consumes: `bucketSchedule`, `hourOfWeek`, `HOURS_PER_WEEK` (Task 2); `heatColor`, `HEAT_EMPTY`, `HEAT_STEPS` (Task 2); and the endpoint (Task 1).
- Produces:
  - `interface ScheduleResponse { since: number; now: number; spans: Array<{ start: number; end: number }> }`
  - `function useLiveSchedule(login: string | null): { data: ScheduleResponse | null; error: string | null }`
  - `LiveSchedule({ data: ScheduleResponse | null; error: string | null })`
- Test ids: `live-schedule`, `schedule-cell` (with `data-hour`, plus `data-now="true"` on the current hour), `schedule-too-new`, `schedule-error`, `schedule-loading`.

- [ ] **Step 1: Write the failing component tests**

Create `apps/frontend/src/components/LiveSchedule.test.tsx`:

```tsx
import { MantineProvider } from "@mantine/core";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { HEAT_EMPTY, HEAT_STEPS } from "../lib/heatRamp.js";
import { renderApp } from "../test-utils.js";
import { theme } from "../theme.js";
import { LiveSchedule } from "./LiveSchedule.js";

// Local time; the 7th and 21st of September 2026 are Mondays.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).getTime();
const TUE_20 = 1 * 24 + 20;

const data = {
  since: at(7, 0),
  now: at(21, 0),
  spans: [
    { start: at(8, 20, 0), end: at(8, 20, 30) },
    { start: at(15, 20, 0), end: at(15, 20, 30) },
    { start: at(9, 20, 0), end: at(9, 20, 30) },
  ],
};

afterEach(() => vi.useRealTimers());

const cellAt = (hour: number) =>
  screen.getAllByTestId("schedule-cell").find((c) => c.dataset.hour === String(hour))!;

test("draws one cell per hour of the week", () => {
  renderApp(<LiveSchedule data={data} error={null} />);
  expect(screen.getAllByTestId("schedule-cell")).toHaveLength(168);
});

test("colours by how often the channel was live in that hour", () => {
  renderApp(<LiveSchedule data={data} error={null} />);
  expect(cellAt(TUE_20).style.backgroundColor).toBe(hexToRgb(HEAT_STEPS[3])); // 2 of 2
  expect(cellAt(2 * 24 + 20).style.backgroundColor).toBe(hexToRgb(HEAT_STEPS[1])); // Wed, 1 of 2
  expect(cellAt(0).style.backgroundColor).toBe(hexToRgb(HEAT_EMPTY)); // never
});

test("each cell says what it means, on hover and to a screen reader", async () => {
  renderApp(<LiveSchedule data={data} error={null} />);
  expect(cellAt(TUE_20)).toHaveAttribute("aria-label", "Tuesdays 20:00–21:00 · live 2 of 2 weeks");
  await userEvent.hover(cellAt(23));
  expect(await screen.findByText("Mondays 23:00–00:00 · live 0 of 2 weeks")).toBeInTheDocument();
});

test("the heading says how many weeks it covers", () => {
  renderApp(<LiveSchedule data={data} error={null} />);
  expect(screen.getByTestId("live-schedule")).toHaveTextContent(/usually live · last 2 weeks/i);
});

test("marks the current hour", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(22, 20, 15)); // a Tuesday, 20:15
  renderApp(<LiveSchedule data={data} error={null} />);
  const marked = screen.getAllByTestId("schedule-cell").filter((c) => c.dataset.now === "true");
  expect(marked.map((c) => c.dataset.hour)).toEqual([String(TUE_20)]);
});

test("under two weeks it says so instead of drawing a sparse grid", () => {
  renderApp(<LiveSchedule data={{ ...data, since: at(9, 0) }} error={null} />);
  expect(screen.getByTestId("schedule-too-new"))
    .toHaveTextContent("Needs a couple of weeks of tracking");
  expect(screen.queryAllByTestId("schedule-cell")).toHaveLength(0);
  // No window worth naming yet, so the heading does not claim one.
  expect(screen.getByTestId("live-schedule")).not.toHaveTextContent(/last \d+ week/i);
});

test("loading and failure each say so", () => {
  const { rerender } = renderApp(<LiveSchedule data={null} error={null} />);
  expect(screen.getByTestId("schedule-loading")).toBeInTheDocument();
  rerender(
    <MantineProvider theme={theme} forceColorScheme="dark">
      <LiveSchedule data={null} error="boom" />
    </MantineProvider>,
  );
  expect(screen.getByTestId("schedule-error")).toHaveTextContent("Schedule unavailable");
});

/** jsdom reports inline colours as rgb(); compare in that form. */
function hexToRgb(hex: string): string {
  const [r, g, b] = hex.slice(1).match(/../g)!.map((x) => parseInt(x, 16));
  return `rgb(${r}, ${g}, ${b})`;
}
```

`rerender` replaces the whole tree `renderApp` built, which is why the last test wraps the new element in the provider again.

Run: `pnpm --filter @app/frontend exec vitest run src/components/LiveSchedule.test.tsx`
Expected: FAIL, because `./LiveSchedule.js` cannot be resolved.

- [ ] **Step 2: Implement the fetch hook**

Create `apps/frontend/src/api/useLiveSchedule.ts`:

```ts
import { useEffect, useState } from "react";
import { api } from "./client.js";

export interface ScheduleResponse {
  since: number;
  now: number;
  spans: Array<{ start: number; end: number }>;
}

/**
 * The channel's live spans for the schedule grid, fetched once per open.
 *
 * Not refetched on the dialog's range changes: the grid has its own fixed
 * window. Null login (dialog closed) clears it, so opening another channel
 * never shows the previous one's grid.
 */
export function useLiveSchedule(login: string | null): {
  data: ScheduleResponse | null;
  error: string | null;
} {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    if (login === null) return;
    let live = true;
    api.get<ScheduleResponse>(`/api/streamers/${encodeURIComponent(login)}/schedule`)
      .then((body) => {
        if (!live) return;
        // Checked rather than trusted: a body without spans would throw
        // inside the grid and take the whole dialog down with it.
        if (!Array.isArray(body?.spans)) throw new Error("malformed schedule");
        setData(body);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "failed to load schedule");
      });
    return () => { live = false; };
  }, [login]);

  return { data, error };
}
```

- [ ] **Step 3: Implement the component**

Create `apps/frontend/src/components/LiveSchedule.module.css`:

```css
/* 24 hour columns after a column of weekday labels. The 2px gap is the
   surface showing between cells, so neighbouring cells never merge. */
.grid {
  display: grid;
  grid-template-columns: 30px repeat(24, minmax(0, 1fr));
  gap: 2px;
  align-items: center;
}

.cell {
  height: 14px;
  border-radius: 2px;
}

/* The hour it is now, so "are they usually on at this time?" is answered
   at a glance. An outline, not a fill: the fill is the data. */
.now {
  outline: 1px solid var(--tw-text);
  outline-offset: 1px;
}

.legendSwatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
```

Create `apps/frontend/src/components/LiveSchedule.tsx`:

```tsx
import { Group, Stack, Text, Tooltip } from "@mantine/core";
import { Fragment } from "react";
import type { ScheduleResponse } from "../api/useLiveSchedule.js";
import { HEAT_EMPTY, HEAT_STEPS, heatColor } from "../lib/heatRamp.js";
import { bucketSchedule, hourOfWeek } from "../lib/liveSchedule.js";
import classes from "./LiveSchedule.module.css";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAYS_PLURAL = [
  "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays",
];
/** Hour labels under the grid; every hour would crowd a 24-column row. */
const HOUR_TICKS = new Set([0, 6, 12, 18]);
/** The grid's own window; the heading reports less when tracking is newer. */
const MAX_WEEKS = 12;
/** Below this the grid is mostly guesswork, so it is not drawn. */
const MIN_WEEKS = 2;

const pad = (hour: number) => `${String(hour % 24).padStart(2, "0")}:00`;

/** "Tuesdays 20:00–21:00 · live 9 of 12 weeks". */
function describe(index: number, live: number, of: number): string {
  const day = Math.floor(index / 24);
  const hour = index % 24;
  return `${DAYS_PLURAL[day]} ${pad(hour)}–${pad(hour + 1)} · live ${live} of ${of} week${of === 1 ? "" : "s"}`;
}

/**
 * When a channel is usually live: hours of the week, shaded by how many of
 * the observed weeks it was live in that hour.
 *
 * It carries its own window in its heading because the dialog's range
 * control above does not govern it.
 */
export function LiveSchedule({ data, error }: {
  data: ScheduleResponse | null;
  error: string | null;
}) {
  const schedule = data === null ? null : bucketSchedule(data.spans, data.since, data.now);
  const drawn = error === null && schedule !== null && schedule.weeks >= MIN_WEEKS;
  // The window actually covered, which is less than twelve weeks for a
  // channel tracked for less. Named only once there is a grid to name it for.
  const heading = drawn
    ? `USUALLY LIVE · LAST ${Math.min(MAX_WEEKS, Math.floor(schedule!.weeks))} WEEKS`
    : "USUALLY LIVE";
  const current = hourOfWeek(new Date());

  let body;
  if (error !== null) {
    body = <Text size="xs" c="dimmed" data-testid="schedule-error">Schedule unavailable.</Text>;
  } else if (schedule === null) {
    body = <Text size="xs" c="dimmed" data-testid="schedule-loading">Loading schedule…</Text>;
  } else if (schedule.weeks < MIN_WEEKS) {
    body = (
      <Text size="xs" c="dimmed" data-testid="schedule-too-new">
        Needs a couple of weeks of tracking.
      </Text>
    );
  } else {
    body = (
      <div className={classes.grid} role="group" aria-label="Live by weekday and hour">
        {DAYS.map((day, d) => (
          <Fragment key={day}>
            <Text size="xs" c="dimmed">{day}</Text>
            {Array.from({ length: 24 }, (_, h) => {
              const index = d * 24 + h;
              const { live, of } = schedule.cells[index];
              const label = describe(index, live, of);
              const now = index === current;
              return (
                <Tooltip key={h} label={label} openDelay={0}>
                  <div
                    role="img"
                    aria-label={label}
                    className={now ? `${classes.cell} ${classes.now}` : classes.cell}
                    style={{ backgroundColor: of === 0 ? HEAT_EMPTY : heatColor(live / of) }}
                    data-testid="schedule-cell"
                    data-hour={index}
                    data-now={now ? "true" : undefined}
                  />
                </Tooltip>
              );
            })}
          </Fragment>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <Text key={h} size="xs" c="dimmed" style={{ fontSize: 10 }}>
            {HOUR_TICKS.has(h) ? h : ""}
          </Text>
        ))}
      </div>
    );
  }

  return (
    <Stack gap="xs" data-testid="live-schedule">
      <Group justify="space-between" align="center">
        <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
          {heading}
        </Text>
        <Group gap={4} wrap="nowrap" aria-hidden>
          <Text size="xs" c="dimmed">never</Text>
          {[HEAT_EMPTY, ...HEAT_STEPS].map((colour) => (
            <span key={colour} className={classes.legendSwatch} style={{ backgroundColor: colour }} />
          ))}
          <Text size="xs" c="dimmed">every week</Text>
        </Group>
      </Group>
      {body}
    </Stack>
  );
}
```

- [ ] **Step 4: Run the component tests**

Run: `pnpm --filter @app/frontend exec vitest run src/components/LiveSchedule.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing dialog test**

In `apps/frontend/src/components/StreamerDetailModal.test.tsx`, append:

```tsx
test("the history view ends with when the channel is usually live", async () => {
  const now = Date.now();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.includes("/schedule")
      ? { since: now - 3 * 7 * 86_400_000, now, spans: [] }
      : {
          series: [], events: [], sessions: [],
          coverage: { live: [], mined: [] }, firstSeen: null, retentionFloor: null,
          gained: null, gainedSince: null,
        }),
  })));
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  expect(await screen.findByTestId("live-schedule")).toHaveTextContent(/last 3 weeks/i);
  expect(screen.getAllByTestId("schedule-cell")).toHaveLength(168);
  const calls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls;
  expect(calls.some(([url]) => url === "/api/streamers/alpha/schedule")).toBe(true);
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/components/StreamerDetailModal.test.tsx`
Expected: FAIL, because there's no `live-schedule` element yet.

- [ ] **Step 6: Render it in the dialog**

In `apps/frontend/src/components/StreamerDetailModal.tsx`:

1. Add the imports:

```tsx
import { useLiveSchedule } from "../api/useLiveSchedule.js";
import { LiveSchedule } from "./LiveSchedule.js";
```

2. Directly after the `useStreamerDetail(...)` call, and so above the `if (s === null) return null;` early return, add:

```tsx
  // Once per open, not per range: the grid has its own fixed window.
  const schedule = useLiveSchedule(opened && s !== null ? s.username : null);
```

3. Inside the history fragment, directly after `<CoverageTimeline … />`, add:

```tsx
              <LiveSchedule data={schedule.data} error={schedule.error} />
```

The other tests in this file stub every URL with a history body, so the schedule fetch gets a body without `spans`, and the hook reports it as an error ("Schedule unavailable."). They don't assert on the schedule, so they're unaffected.

- [ ] **Step 7: Run the affected suites and the typecheck**

Run: `pnpm --filter @app/frontend exec vitest run src/components/LiveSchedule.test.tsx src/components/StreamerDetailModal.test.tsx src/components/StreamerDetailHost.test.tsx src/routes/Dashboard.test.tsx`
Expected: PASS.

Run: `pnpm --filter @app/frontend exec tsc -b`
Expected: exit 0.

- [ ] **Step 8: Show the diffstat, then commit once approved**

```bash
git add apps/frontend/src/api/useLiveSchedule.ts \
  apps/frontend/src/components/LiveSchedule.tsx apps/frontend/src/components/LiveSchedule.module.css \
  apps/frontend/src/components/LiveSchedule.test.tsx \
  apps/frontend/src/components/StreamerDetailModal.tsx \
  apps/frontend/src/components/StreamerDetailModal.test.tsx
git commit -m "feat(ui): show when a channel is usually live in its detail dialog

A weekday-by-hour grid below the coverage timeline, shaded by how many
of the observed weeks the channel was live in each hour, with the
current hour outlined. Each cell says what it means on hover and to a
screen reader. It is fetched once per open, carries its own window in
its heading, and asks for a couple of weeks of tracking before drawing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Verify in the built app

**Files:** none in the repo. The Playwright script lives in `~/.pw-tools`.

- [ ] **Step 1: Run the whole suites and the build**

Run: `pnpm --filter @app/backend test` and `pnpm --filter @app/frontend test`
Expected: all pass.

Run: `pnpm run build`
Expected: a clean build.

- [ ] **Step 2: Start the built app on a copy of the dev data**

Make sure nothing else holds the port first: `pgrep -fa "backend/dist/index.js"` must print nothing. If it does, stop that process by pid.

```bash
rm -rf /tmp/schedule-check && mkdir -p /tmp/schedule-check
cp .devdata/history.db .devdata/config.json /tmp/schedule-check/
DATA_DIR=/tmp/schedule-check APP_PASSWORD=x PORT=8123 \
  STATIC_ROOT=./apps/frontend/dist node apps/backend/dist/index.js
```

Run the server in the background, and check its log for `listening on` before continuing.

- [ ] **Step 3: Screenshot a channel with enough history and one without**

In the dev data, `streamerhouse` was first seen on 2026-09-05, so it gets a grid. `cohhcarnage` was first seen on 2026-09-13, so it gets the too-new message.

Create `~/.pw-tools/schedule.mjs`:

```js
import { chromium } from "playwright";
const base = "http://127.0.0.1:8123";
const b = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, baseURL: base });
await ctx.request.post("/api/session", { data: { password: "x" } });
const p = await ctx.newPage();
await p.goto(base);

for (const login of ["streamerhouse", "cohhcarnage"]) {
  console.log(login, JSON.stringify(
    await (await ctx.request.get(`/api/streamers/${login}/schedule`)).json(),
  ).slice(0, 200));
  await p.getByTestId(`streamer-${login}`).click();
  const section = p.getByTestId("live-schedule");
  await section.waitFor();
  await section.scrollIntoViewIfNeeded();
  await p.waitForTimeout(400);
  const cells = await p.getByTestId("schedule-cell").count();
  console.log(login, "cells:", cells, "text:", (await section.textContent()).slice(0, 80));
  if (cells > 0) {
    await p.getByTestId("schedule-cell").nth(20).hover();
    await p.waitForTimeout(300);
  }
  await p.screenshot({ path: `/tmp/schedule-check/${login}.png` });
  await p.keyboard.press("Escape");
  await p.waitForTimeout(400);
}
await b.close();
```

Run: `cd ~/.pw-tools && . ./env.sh && node schedule.mjs`
Expected:
- `streamerhouse`: 168 cells and a heading reading "USUALLY LIVE · LAST 2 WEEKS". Its screenshot shows the grid, some shaded hours, one outlined cell and a hover tooltip.
- `cohhcarnage`: 0 cells and "Needs a couple of weeks of tracking".

Look at both screenshots. Check that the grid fits the dialog without horizontal overflow and that the labels don't collide. Then send them to the user with `SendUserFile`; if delivery fails, say where they are. Stop the server by pid afterwards.

- [ ] **Step 4: Report**

Summarise the commits, the test counts, the screenshots, and anything seen in the browser that the tests didn't predict.

---

## Out of this plan

- Slice 4 (the Insights screen, the rollup and the calendar) gets its own plan. It reuses `heatRamp.ts`.
