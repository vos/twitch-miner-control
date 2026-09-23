# Animated Balances Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Balances roll to their new value when points arrive, and a card that earned points floats a small green `+N`.

**Architecture:** One hook decides, per live snapshot, whether that frame's changes may animate. It says no for the first frame, the SQLite `pending` frame and the frame that replaces it, a frame that arrived while the tab was hidden, and whenever reduced motion is set. A second hook eases a number toward its target with `requestAnimationFrame`, and `RollingNumber` renders it. A third hook turns a positive change into a one-off `+N` float. The Dashboard and the detail-dialog host call the decision hook once and pass the result down as a prop, so the cards and the dialog stay plain components that are easy to test.

**Tech Stack:** React 19, Mantine 9.6 (`@mantine/hooks` `useReducedMotion`, `@mantine/core` `VisuallyHidden`), CSS modules, Vitest + Testing Library, Playwright for the browser check.

**Spec:** `docs/superpowers/specs/2026-09-23-insights-and-palette-design.md`, section "Slice 2: Animated balances". This is slice 2 of 4; slice 1, the command palette, is merged.

## Global Constraints

- **Never commit without the user's go-ahead.** Show the task's diffstat and wait, unless the user has picked a commit rhythm for this run. Commit on `main` with no branch. Use conventional-commit subjects with an explanatory body, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Comments** describe the current code. Don't narrate rejected alternatives, but keep any note that stops a future change from breaking something.
- **Roll duration is 600ms, ease-out.** The float rises about 16px and fades over 1.2s in `--tw-success`.
- **A change animates only when all of these hold; otherwise the value snaps:**
  - neither the previous nor the new snapshot is `pending`
  - both values are non-null
  - the tab was visible for both frames
  - `prefers-reduced-motion` is not set
- **Floats appear only on increases,** only on the cards (not the Total tile), and a new one replaces the one in flight. Under reduced motion there is no float at all.
- **At rest, a rolling number renders exactly the formatted value as its text,** with no extra nodes. Existing tests assert on exact text such as `/^123,476$/`. While rolling, the moving digits are `aria-hidden` and a `VisuallyHidden` span carries the final value.
- `verbatimModuleSyntax` is on, so type-only imports use `import type`.
- Test one file with `pnpm --filter @app/frontend exec vitest run <path>` (run from the repo root), and the whole frontend with `pnpm --filter @app/frontend test`. Typecheck with `pnpm --filter @app/frontend exec tsc -b`.
- **Fake `requestAnimationFrame`** with `vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] })`, and advance it inside `act(() => vi.advanceTimersByTime(ms))`. This was verified to work under vitest 5.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `apps/frontend/src/lib/balanceMotion.ts` | create | `canAnimate` (pure), `useFrameMotion` (per-snapshot decision), `useBalanceMotion` (wired to live state and reduced motion) |
| `apps/frontend/src/lib/useAnimatedNumber.ts` | create | Eases a number toward its target over 600ms |
| `apps/frontend/src/components/RollingNumber.tsx` | create | Renders an animated, formatted number with an accessible final value |
| `apps/frontend/src/lib/useGainFloat.ts` | create | Turns a positive change into a `{ amount, id }` float |
| `apps/frontend/src/components/GainFloat.tsx` + `.module.css` | create | The rising `+N` |
| `apps/frontend/src/components/StatTile.tsx` | modify | `value` accepts a `ReactNode` |
| `apps/frontend/src/components/StreamerCard.tsx` + `.module.css` | modify | `animate` prop, rolling balance, float |
| `apps/frontend/src/routes/Dashboard.tsx` | modify | Calls `useBalanceMotion` and passes it to the cards and the Total tile |
| `apps/frontend/src/components/StreamerDetailHost.tsx` | modify | Calls `useBalanceMotion` and passes it to the dialog |
| `apps/frontend/src/components/StreamerDetailModal.tsx` | modify | `animateBalance` prop, rolling balance |

---

### Task 1: Decide which frames may animate

**Files:**
- Create: `apps/frontend/src/lib/balanceMotion.ts`
- Create: `apps/frontend/src/lib/balanceMotion.test.ts`

**Interfaces:**
- Consumes: `useLiveState` and `type StateSnapshot` from `../api/useLiveState.js`, and `useReducedMotion` from `@mantine/hooks`.
- Produces:
  - `interface FrameMotion { pending: boolean; visible: boolean }`
  - `function canAnimate(prev: FrameMotion | null, next: FrameMotion, reducedMotion: boolean): boolean`
  - `function useFrameMotion(snapshot: StateSnapshot | null, reducedMotion: boolean): boolean`
  - `function useBalanceMotion(): boolean`, which must be called under a `LiveStateProvider`

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/lib/balanceMotion.test.ts`:

```ts
import { renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { StateSnapshot } from "../api/useLiveState.js";
import { canAnimate, useFrameMotion } from "./balanceMotion.js";

const live = { pending: false, visible: true };

test("the first frame never animates", () => {
  expect(canAnimate(null, live, false)).toBe(false);
});

test("two complete, visible frames animate", () => {
  expect(canAnimate(live, live, false)).toBe(true);
});

test("a pending frame on either side snaps", () => {
  // The SQLite frame's jump to Twitch's figure is a correction, not a gain.
  expect(canAnimate({ pending: true, visible: true }, live, false)).toBe(false);
  expect(canAnimate(live, { pending: true, visible: true }, false)).toBe(false);
});

test("a frame seen while hidden, on either side, snaps", () => {
  expect(canAnimate({ pending: false, visible: false }, live, false)).toBe(false);
  expect(canAnimate(live, { pending: false, visible: false }, false)).toBe(false);
});

test("reduced motion always snaps", () => {
  expect(canAnimate(live, live, true)).toBe(false);
});

// --- useFrameMotion: the same rules, applied to a sequence of snapshots ---

const frame = (pending = false): StateSnapshot =>
  ({ streamers: [], lastUpdated: 1, stale: false, error: null, pending });

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true, get: () => state,
  });
}

afterEach(() => setVisibility("visible"));

function track(reduced = false) {
  return renderHook(
    ({ snapshot }: { snapshot: StateSnapshot | null }) => useFrameMotion(snapshot, reduced),
    { initialProps: { snapshot: null as StateSnapshot | null } },
  );
}

test("no snapshot, then the first one: neither animates", () => {
  const { result, rerender } = track();
  expect(result.current).toBe(false);
  rerender({ snapshot: frame() });
  expect(result.current).toBe(false);
});

test("the second complete frame animates, and re-renders keep the decision", () => {
  const { result, rerender } = track();
  rerender({ snapshot: frame() });
  const second = frame();
  rerender({ snapshot: second });
  expect(result.current).toBe(true);
  rerender({ snapshot: second });
  expect(result.current).toBe(true);
});

test("the frame after a pending one snaps; the one after that animates", () => {
  const { result, rerender } = track();
  rerender({ snapshot: frame(true) });
  rerender({ snapshot: frame() });
  expect(result.current).toBe(false);
  rerender({ snapshot: frame() });
  expect(result.current).toBe(true);
});

test("coming back to the tab snaps the first frame after", () => {
  const { result, rerender } = track();
  rerender({ snapshot: frame() });
  setVisibility("hidden");
  rerender({ snapshot: frame() });
  expect(result.current).toBe(false);
  setVisibility("visible");
  rerender({ snapshot: frame() });
  expect(result.current).toBe(false);
  rerender({ snapshot: frame() });
  expect(result.current).toBe(true);
});

test("reduced motion never animates", () => {
  const { result, rerender } = track(true);
  rerender({ snapshot: frame() });
  rerender({ snapshot: frame() });
  expect(result.current).toBe(false);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/frontend exec vitest run src/lib/balanceMotion.test.ts`
Expected: FAIL, because `./balanceMotion.js` cannot be resolved.

- [ ] **Step 3: Implement**

Create `apps/frontend/src/lib/balanceMotion.ts`:

```ts
import { useReducedMotion } from "@mantine/hooks";
import { useState } from "react";
import { useLiveState, type StateSnapshot } from "../api/useLiveState.js";

/** What about a live frame decides whether its changes may animate. */
export interface FrameMotion {
  /** Built from SQLite alone, with Twitch's figures still to come. */
  pending: boolean;
  /** The tab was visible when the frame arrived. */
  visible: boolean;
}

/**
 * Whether the change from one frame to the next is one the user watched
 * happen, and so may animate.
 *
 * Anything else snaps. The first frame is the page loading. A pending
 * frame's figures are about to be corrected by Twitch's, and that jump is
 * a correction rather than a gain. A frame that arrived while the tab was
 * hidden carries changes nobody saw, and replaying them on return would
 * show old news as new.
 */
export function canAnimate(
  prev: FrameMotion | null,
  next: FrameMotion,
  reducedMotion: boolean,
): boolean {
  if (reducedMotion || prev === null) return false;
  return !prev.pending && prev.visible && !next.pending && next.visible;
}

interface Seen {
  snapshot: StateSnapshot | null;
  frame: FrameMotion | null;
  animate: boolean;
}

/**
 * `canAnimate` applied to each new snapshot as it arrives.
 *
 * Decided once per snapshot object, not per render: a re-render that
 * carries the same snapshot keeps the answer that snapshot got. Visibility
 * is read at arrival, which is the moment that decides whether the change
 * was seen.
 */
export function useFrameMotion(snapshot: StateSnapshot | null, reducedMotion: boolean): boolean {
  const [seen, setSeen] = useState<Seen>({ snapshot: null, frame: null, animate: false });
  if (snapshot === seen.snapshot) return seen.animate;

  const frame = snapshot === null ? null : {
    pending: snapshot.pending === true,
    visible: document.visibilityState === "visible",
  };
  const next = {
    snapshot, frame,
    animate: frame !== null && canAnimate(seen.frame, frame, reducedMotion),
  };
  setSeen(next);
  return next.animate;
}

/** Whether the balances in the current live snapshot may animate. */
export function useBalanceMotion(): boolean {
  const { snapshot } = useLiveState();
  return useFrameMotion(snapshot, useReducedMotion());
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @app/frontend exec vitest run src/lib/balanceMotion.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Show the diffstat, then commit once approved**

```bash
git add apps/frontend/src/lib/balanceMotion.ts apps/frontend/src/lib/balanceMotion.test.ts
git commit -m "feat(ui): decide which live frames may animate a balance

A change animates only between two complete frames that both arrived
while the tab was visible, and never under reduced motion. The first
frame, the SQLite pending frame and its correction, and anything that
changed while nobody was looking all snap.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `useAnimatedNumber` and `RollingNumber`

**Files:**
- Create: `apps/frontend/src/lib/useAnimatedNumber.ts`
- Create: `apps/frontend/src/lib/useAnimatedNumber.test.ts`
- Create: `apps/frontend/src/components/RollingNumber.tsx`
- Create: `apps/frontend/src/components/RollingNumber.test.tsx`

**Interfaces:**
- Produces:
  - `const ROLL_MS = 600`
  - `function easeOut(t: number): number`
  - `function useAnimatedNumber(value: number | null, animate: boolean, duration?: number): number | null`
  - `RollingNumber({ value: number | null; animate: boolean })`, which renders `—` for null and otherwise the `en-US`-formatted number

- [ ] **Step 1: Write the failing hook tests**

Create `apps/frontend/src/lib/useAnimatedNumber.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { easeOut, useAnimatedNumber } from "./useAnimatedNumber.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => vi.useRealTimers());

function track(value: number | null, animate: boolean) {
  return renderHook(
    (p: { value: number | null; animate: boolean }) => useAnimatedNumber(p.value, p.animate),
    { initialProps: { value, animate } },
  );
}

test("easing starts at 0, ends at 1 and front-loads the distance", () => {
  expect(easeOut(0)).toBe(0);
  expect(easeOut(1)).toBe(1);
  expect(easeOut(0.5)).toBeGreaterThan(0.5);
});

test("without animation a change lands at once", () => {
  const { result, rerender } = track(1000, false);
  rerender({ value: 2000, animate: false });
  expect(result.current).toBe(2000);
});

test("with animation it rolls from the old value to the new one", () => {
  const { result, rerender } = track(1000, true);
  rerender({ value: 2000, animate: true });
  expect(result.current).toBe(1000);

  act(() => vi.advanceTimersByTime(300));
  expect(result.current).toBeGreaterThan(1000);
  expect(result.current).toBeLessThan(2000);

  act(() => vi.advanceTimersByTime(400));
  expect(result.current).toBe(2000);
});

test("a snapped change mid-roll lands at once", () => {
  const { result, rerender } = track(1000, true);
  rerender({ value: 2000, animate: true });
  act(() => vi.advanceTimersByTime(200));
  rerender({ value: 3000, animate: false });
  expect(result.current).toBe(3000);
});

test("a second animated change continues from where the first had got to", () => {
  const { result, rerender } = track(1000, true);
  rerender({ value: 2000, animate: true });
  act(() => vi.advanceTimersByTime(200));
  const midway = result.current!;
  rerender({ value: 3000, animate: true });
  expect(result.current).toBe(midway);
  act(() => vi.advanceTimersByTime(700));
  expect(result.current).toBe(3000);
});

test("to or from null there is nothing to roll between", () => {
  const { result, rerender } = track(null, true);
  rerender({ value: 500, animate: true });
  expect(result.current).toBe(500);
  rerender({ value: null, animate: true });
  expect(result.current).toBeNull();
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/lib/useAnimatedNumber.test.ts`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 2: Implement the hook**

Create `apps/frontend/src/lib/useAnimatedNumber.ts`:

```ts
import { useEffect, useRef, useState } from "react";

/** How long a balance takes to roll to its new value. */
export const ROLL_MS = 600;

/** Fast start, gentle landing: most of the distance is covered early. */
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * `value`, eased toward over `duration` whenever it changes with `animate`
 * set; otherwise `value` itself, at once.
 *
 * A change arriving mid-roll continues from the figure currently shown
 * rather than jumping back to where the roll began.
 */
export function useAnimatedNumber(
  value: number | null,
  animate: boolean,
  duration = ROLL_MS,
): number | null {
  const [shown, setShown] = useState(value);
  // What is on screen right now, for a roll that starts mid-roll.
  const shownRef = useRef(value);

  useEffect(() => {
    const from = shownRef.current;
    if (!animate || from === null || value === null || from === value) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    let start: number | null = null;
    let frame = requestAnimationFrame(function step(now) {
      start ??= now;
      const t = Math.min(1, (now - start) / duration);
      const next = t === 1 ? value : Math.round(from + (value - from) * easeOut(t));
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, animate, duration]);

  // A snapped change is returned directly: waiting for the effect would
  // paint the old figure for a frame.
  return animate ? shown : value;
}
```

Run the hook tests. Expected: PASS (6 tests).

- [ ] **Step 3: Write the failing component tests**

Create `apps/frontend/src/components/RollingNumber.test.tsx`:

```tsx
import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RollingNumber } from "./RollingNumber.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => vi.useRealTimers());

const ui = (value: number | null, animate: boolean) => (
  <MantineProvider>
    <span data-testid="n"><RollingNumber value={value} animate={animate} /></span>
  </MantineProvider>
);

test("at rest it is the formatted figure and nothing else", () => {
  render(ui(1234567, false));
  // Exact: other tests match balances with anchored patterns.
  expect(screen.getByTestId("n").textContent).toBe("1,234,567");
});

test("null reads as a dash", () => {
  render(ui(null, true));
  expect(screen.getByTestId("n").textContent).toBe("—");
});

test("while rolling, the moving digits are hidden and the final figure is not", () => {
  const { rerender } = render(ui(1000, true));
  rerender(ui(2000, true));
  act(() => vi.advanceTimersByTime(200));

  const moving = screen.getByTestId("n").querySelector("[aria-hidden]");
  expect(moving).not.toBeNull();
  expect(moving!.textContent).not.toBe("2,000");
  // A screen reader hears only where the balance is going.
  expect(screen.getByText("2,000")).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByTestId("n").textContent).toBe("2,000");
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/components/RollingNumber.test.tsx`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 4: Implement the component**

Create `apps/frontend/src/components/RollingNumber.tsx`:

```tsx
import { VisuallyHidden } from "@mantine/core";
import { useAnimatedNumber } from "../lib/useAnimatedNumber.js";

const nf = new Intl.NumberFormat("en-US");

/**
 * A formatted count that rolls to a new value when `animate` is set.
 *
 * At rest it renders the bare figure. Only while it moves does it split
 * in two: the moving digits are aria-hidden, and a visually hidden copy of
 * the final figure is what assistive tech reads, so nobody hears a dozen
 * intermediate balances.
 */
export function RollingNumber({ value, animate }: {
  value: number | null;
  animate: boolean;
}) {
  const shown = useAnimatedNumber(value, animate);
  if (value === null) return <>—</>;
  if (shown === null || shown === value) return <>{nf.format(value)}</>;
  return (
    <>
      <span aria-hidden>{nf.format(shown)}</span>
      <VisuallyHidden>{nf.format(value)}</VisuallyHidden>
    </>
  );
}
```

Run: `pnpm --filter @app/frontend exec vitest run src/lib/useAnimatedNumber.test.ts src/components/RollingNumber.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 5: Show the diffstat, then commit once approved**

```bash
git add apps/frontend/src/lib/useAnimatedNumber.ts apps/frontend/src/lib/useAnimatedNumber.test.ts \
  apps/frontend/src/components/RollingNumber.tsx apps/frontend/src/components/RollingNumber.test.tsx
git commit -m "feat(ui): add a number that rolls to its new value

useAnimatedNumber eases toward a changed value over 600ms, continuing
from the figure on screen when a change lands mid-roll, and returns a
snapped value at once. RollingNumber renders it: the bare figure at
rest, and while moving, aria-hidden digits beside a visually hidden
final value.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Roll the balances on the cards, the Total tile and the dialog

**Files:**
- Modify: `apps/frontend/src/components/StatTile.tsx` (the `value` prop type)
- Modify: `apps/frontend/src/components/StreamerCard.tsx:17-20,120`
- Modify: `apps/frontend/src/components/StreamerCard.test.tsx`
- Modify: `apps/frontend/src/routes/Dashboard.tsx:127,227,237-241,255-259,329`
- Modify: `apps/frontend/src/components/StreamerDetailHost.tsx`
- Modify: `apps/frontend/src/components/StreamerDetailModal.tsx:23-27,129`

**Interfaces:**
- Consumes: `useBalanceMotion()` (Task 1) and `RollingNumber` (Task 2).
- Produces: the `StreamerCard` prop `animate?: boolean` (default `false`) and the `StreamerDetailModal` prop `animateBalance?: boolean` (default `false`). The defaults keep every existing caller and test on snapped values.

- [ ] **Step 1: Write the failing card test**

In `apps/frontend/src/components/StreamerCard.test.tsx`, change the vitest import to `import { afterEach, expect, test, vi } from "vitest";`, add `act` to the `@testing-library/react` import, and append:

```tsx
test("an animated balance rolls, and lands on the new figure", () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  const card = (points: number) => (
    <MantineProvider>
      <StreamerCard streamer={{ ...base, points }} animate />
    </MantineProvider>
  );
  const { rerender } = render(card(1000));
  rerender(card(2000));
  act(() => vi.advanceTimersByTime(200));
  expect(screen.getByTestId("balance").querySelector("[aria-hidden]:not(svg)"))
    .not.toBeNull();
  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByTestId("balance")).toHaveTextContent("2,000");
});

afterEach(() => vi.useRealTimers());
```

Run: `pnpm --filter @app/frontend exec vitest run src/components/StreamerCard.test.tsx`
Expected: FAIL. The card has no `animate` prop, so the balance snaps and there's no moving `aria-hidden` span.

- [ ] **Step 2: Let a stat tile hold an element**

In `apps/frontend/src/components/StatTile.tsx`, change the `value` prop's type from `string` to `ReactNode`. `ReactNode` is already imported as a type. No other change is needed: the value is rendered as a child.

- [ ] **Step 3: Roll the card's balance**

In `apps/frontend/src/components/StreamerCard.tsx`:

1. Add `import { RollingNumber } from "./RollingNumber.js";`.
2. Change the signature to:

```tsx
export function StreamerCard({ streamer: s, onOpen, animate = false }: {
  streamer: StreamerState;
  onOpen?: () => void;
  /** Whether a change to this frame's balance may roll; see useBalanceMotion. */
  animate?: boolean;
}) {
```

3. Replace `{s.points === null ? "—" : nf.format(s.points)}` inside the balance `<Text>` with:

```tsx
            <RollingNumber value={s.points} animate={animate} />
```

4. If `nf` is now unused in this file, delete its declaration (`grep -n "nf\." apps/frontend/src/components/StreamerCard.tsx` to check).

Run the card tests. Expected: PASS, the whole file.

- [ ] **Step 4: Roll the dashboard's balances**

In `apps/frontend/src/routes/Dashboard.tsx`:

1. Add the imports:

```tsx
import { RollingNumber } from "../components/RollingNumber.js";
import { useBalanceMotion } from "../lib/balanceMotion.js";
```

2. Directly after `const { snapshot, loadError } = useLiveState();`, add:

```tsx
  // Decided once here and handed down, so the cards stay plain components.
  const motion = useBalanceMotion();
```

   This line must stay above the `if (!snapshot)` early return: it is a hook.
3. Delete the `totalText` line (`const totalText = snapshot.lastUpdated === null ? "—" : nf.format(total);`) and change the Total tile's `value={totalText}` to:

```tsx
          value={snapshot.lastUpdated === null
            ? "—"
            : <RollingNumber value={total} animate={motion} />}
```

4. Add `animate={motion}` to both `<StreamerCard … />` elements, the live grid and the offline grid.

`nf` is still used by `gainedText`, so it stays.

- [ ] **Step 5: Roll the dialog's balance**

In `apps/frontend/src/components/StreamerDetailModal.tsx`:

1. Add `import { RollingNumber } from "./RollingNumber.js";`.
2. Add the prop to the signature:

```tsx
export function StreamerDetailModal({ streamer, opened, onClose, animateBalance = false }: {
  streamer: StreamerState | null;
  opened: boolean;
  onClose: () => void;
  /** Whether a change to the balance may roll; see useBalanceMotion. */
  animateBalance?: boolean;
}) {
```

3. Replace `{s.points === null ? "—" : nf.format(s.points)}` inside the `detail-balance` `<Text>` with `<RollingNumber value={s.points} animate={animateBalance} />`.
4. If `nf` is now unused in the file, delete its declaration.

In `apps/frontend/src/components/StreamerDetailHost.tsx`:

1. Add `import { useBalanceMotion } from "../lib/balanceMotion.js";`.
2. Directly after `const { snapshot } = useLiveState();`, add `const animateBalance = useBalanceMotion();`. It must come before the `if (!used) return null;` early return.
3. Pass `animateBalance={animateBalance}` to `<StreamerDetailModal>`.

- [ ] **Step 6: Run the affected suites and the typecheck**

Run: `pnpm --filter @app/frontend exec vitest run src/components/StreamerCard.test.tsx src/components/StatTile.test.tsx src/routes/Dashboard.test.tsx src/components/StreamerDetailModal.test.tsx src/components/StreamerDetailHost.test.tsx`
Expected: PASS. In particular, `Dashboard.test.tsx`'s `toHaveTextContent(/^123,476$/)` still holds, because a number at rest renders bare.

Run: `pnpm --filter @app/frontend exec tsc -b`
Expected: exit 0.

- [ ] **Step 7: Show the diffstat, then commit once approved**

```bash
git add apps/frontend/src/components/StatTile.tsx \
  apps/frontend/src/components/StreamerCard.tsx apps/frontend/src/components/StreamerCard.test.tsx \
  apps/frontend/src/routes/Dashboard.tsx apps/frontend/src/components/StreamerDetailHost.tsx \
  apps/frontend/src/components/StreamerDetailModal.tsx
git commit -m "feat(ui): roll balances to their new value as points arrive

The card balances, the Total points tile and the detail dialog's
balance roll over 600ms when a live frame changes them. The dashboard
and the dialog host each ask useBalanceMotion once and pass the answer
down, so a page load, the SQLite frame's correction and anything that
changed in a background tab still snap.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The floating `+N` on a card

**Files:**
- Create: `apps/frontend/src/lib/useGainFloat.ts`
- Create: `apps/frontend/src/lib/useGainFloat.test.ts`
- Create: `apps/frontend/src/components/GainFloat.tsx`
- Create: `apps/frontend/src/components/GainFloat.module.css`
- Modify: `apps/frontend/src/components/StreamerCard.tsx`
- Modify: `apps/frontend/src/components/StreamerCard.module.css` (`.balance`)
- Modify: `apps/frontend/src/components/StreamerCard.test.tsx`

**Interfaces:**
- Consumes: the `StreamerCard` `animate` prop (Task 3).
- Produces:
  - `interface GainFloatState { amount: number; id: number }`
  - `function useGainFloat(value: number | null, animate: boolean): [GainFloatState | null, () => void]`
  - `GainFloat({ float: GainFloatState | null; onDone: () => void })`, with the test id `gain-float`

- [ ] **Step 1: Write the failing hook tests**

Create `apps/frontend/src/lib/useGainFloat.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useGainFloat } from "./useGainFloat.js";

function track(value: number | null, animate = true) {
  return renderHook(
    (p: { value: number | null; animate: boolean }) => useGainFloat(p.value, p.animate),
    { initialProps: { value, animate } },
  );
}

test("nothing floats until the value changes", () => {
  const { result } = track(1000);
  expect(result.current[0]).toBeNull();
});

test("an animated increase floats the difference", () => {
  const { result, rerender } = track(1000);
  rerender({ value: 1050, animate: true });
  expect(result.current[0]).toMatchObject({ amount: 50 });
});

test("a decrease never floats", () => {
  const { result, rerender } = track(1000);
  rerender({ value: 900, animate: true });
  expect(result.current[0]).toBeNull();
});

test("a snapped increase does not float", () => {
  const { result, rerender } = track(1000);
  rerender({ value: 1050, animate: false });
  expect(result.current[0]).toBeNull();
});

test("a second gain replaces the first under a new id", () => {
  const { result, rerender } = track(1000);
  rerender({ value: 1050, animate: true });
  const first = result.current[0]!;
  rerender({ value: 1060, animate: true });
  expect(result.current[0]).toEqual({ amount: 10, id: first.id + 1 });
});

test("clearing removes it", () => {
  const { result, rerender } = track(1000);
  rerender({ value: 1050, animate: true });
  act(() => result.current[1]());
  expect(result.current[0]).toBeNull();
});

test("from or to null there is no gain to show", () => {
  const { result, rerender } = track(null);
  rerender({ value: 1000, animate: true });
  expect(result.current[0]).toBeNull();
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/lib/useGainFloat.test.ts`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 2: Implement the hook**

Create `apps/frontend/src/lib/useGainFloat.ts`:

```ts
import { useState } from "react";

export interface GainFloatState {
  amount: number;
  /** New for every gain, so a gain arriving mid-float restarts it. */
  id: number;
}

/**
 * The gain to float over a balance, and a way to clear it once shown.
 *
 * Only an animated increase floats. A decrease is spending, which is not
 * worth celebrating, and a snapped change is one the user did not watch
 * happen.
 */
export function useGainFloat(
  value: number | null,
  animate: boolean,
): [GainFloatState | null, () => void] {
  const [float, setFloat] = useState<GainFloatState | null>(null);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    if (animate && prev !== null && value !== null && value > prev) {
      setFloat({ amount: value - prev, id: (float?.id ?? 0) + 1 });
    }
  }
  return [float, () => setFloat(null)];
}
```

Run the hook tests. Expected: PASS (7 tests).

- [ ] **Step 3: Write the failing card tests**

Append to `apps/frontend/src/components/StreamerCard.test.tsx`, adding `fireEvent` to the `@testing-library/react` import:

```tsx
const animated = (points: number, animate = true) => {
  // jsdom has a real requestAnimationFrame; faked, so no roll outlives
  // the test. The afterEach added in Task 3 restores real timers.
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  return (
    <MantineProvider>
      <StreamerCard streamer={{ ...base, points }} animate={animate} />
    </MantineProvider>
  );
};

test("a gain floats its amount over the balance, then goes", () => {
  const { rerender } = render(animated(1000));
  rerender(animated(1050));
  const float = screen.getByTestId("gain-float");
  expect(float).toHaveTextContent("+50");
  // Decoration only: the balance itself already says what changed.
  expect(float).toHaveAttribute("aria-hidden", "true");
  fireEvent.animationEnd(float);
  expect(screen.queryByTestId("gain-float")).toBeNull();
});

test("spending floats nothing", () => {
  const { rerender } = render(animated(1000));
  rerender(animated(900));
  expect(screen.queryByTestId("gain-float")).toBeNull();
});

test("a card that is not animating floats nothing", () => {
  const { rerender } = render(animated(1000, false));
  rerender(animated(1050, false));
  expect(screen.queryByTestId("gain-float")).toBeNull();
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/components/StreamerCard.test.tsx`
Expected: FAIL, because there's no `gain-float` yet.

- [ ] **Step 4: Implement the float**

Create `apps/frontend/src/components/GainFloat.module.css`:

```css
/* Rises from just above the balance's right edge and fades. Absolute, so
   it never pushes the gains beside the balance around. */
.float {
  position: absolute;
  right: 0;
  bottom: 75%;
  font-size: 13px;
  font-weight: 700;
  color: var(--tw-success);
  white-space: nowrap;
  pointer-events: none;
  animation: rise 1200ms ease-out forwards;
}

@keyframes rise {
  from { opacity: 0; transform: translateY(4px); }
  15% { opacity: 1; }
  to { opacity: 0; transform: translateY(-16px); }
}

/* No float at all rather than a still one: a +N that sits there reads as
   part of the balance. */
@media (prefers-reduced-motion: reduce) {
  .float { display: none; }
}
```

Create `apps/frontend/src/components/GainFloat.tsx`:

```tsx
import type { GainFloatState } from "../lib/useGainFloat.js";
import classes from "./GainFloat.module.css";

const nf = new Intl.NumberFormat("en-US");

/**
 * A `+N` that rises off a balance and fades.
 *
 * Keyed by the gain's id, so a second gain mid-float remounts it and the
 * animation starts over rather than finishing the first one's run.
 */
export function GainFloat({ float, onDone }: {
  float: GainFloatState | null;
  onDone: () => void;
}) {
  if (float === null) return null;
  return (
    <span
      key={float.id}
      className={classes.float}
      aria-hidden="true"
      data-testid="gain-float"
      onAnimationEnd={onDone}
    >
      +{nf.format(float.amount)}
    </span>
  );
}
```

In `apps/frontend/src/components/StreamerCard.module.css`, add `position: relative;` to the `.balance` rule, with this comment above the property:

```css
  /* The anchor for GainFloat's rising +N. */
```

In `apps/frontend/src/components/StreamerCard.tsx`:

1. Add the imports:

```tsx
import { GainFloat } from "./GainFloat.js";
import { useGainFloat } from "../lib/useGainFloat.js";
```

2. After the `const elapsed = …` line, add:

```tsx
  const [float, clearFloat] = useGainFloat(s.points, animate);
```

3. Inside the balance `<Text>`, directly after `<RollingNumber … />`, add:

```tsx
            <GainFloat float={float} onDone={clearFloat} />
```

- [ ] **Step 5: Run the affected suites and the typecheck**

Run: `pnpm --filter @app/frontend exec vitest run src/lib/useGainFloat.test.ts src/components/StreamerCard.test.tsx src/routes/Dashboard.test.tsx`
Expected: PASS.

Run: `pnpm --filter @app/frontend exec tsc -b`
Expected: exit 0.

- [ ] **Step 6: Show the diffstat, then commit once approved**

```bash
git add apps/frontend/src/lib/useGainFloat.ts apps/frontend/src/lib/useGainFloat.test.ts \
  apps/frontend/src/components/GainFloat.tsx apps/frontend/src/components/GainFloat.module.css \
  apps/frontend/src/components/StreamerCard.tsx apps/frontend/src/components/StreamerCard.module.css \
  apps/frontend/src/components/StreamerCard.test.tsx
git commit -m "feat(ui): float a card's gain over its balance

When a card's balance rises in a frame that may animate, a green +N
rises off it and fades over 1.2s. A second gain restarts it; spending,
snapped changes and reduced motion float nothing. It is aria-hidden:
the balance already says what changed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Verify in the built app

**Files:** none in the repo. The Playwright script lives in `~/.pw-tools`.

- [ ] **Step 1: Run the whole suite and the build**

Run: `pnpm --filter @app/frontend test`
Expected: every test passes.

Run: `pnpm run build`
Expected: a clean build.

- [ ] **Step 2: Start the built app on a copy of the dev data**

```bash
rm -rf /tmp/motion-check && mkdir -p /tmp/motion-check
cp .devdata/history.db .devdata/config.json /tmp/motion-check/
DATA_DIR=/tmp/motion-check APP_PASSWORD=x PORT=8123 \
  STATIC_ROOT=./apps/frontend/dist node apps/backend/dist/index.js
```

Run the server in the background.

- [ ] **Step 3: Drive live frames by hand and screenshot**

The dev instance has no Twitch login, so real frames won't carry gains. Replace `EventSource` before the page loads, so the script can push `state` frames itself. The app's listener JSON-parses `MessageEvent.data` for each event type it subscribes to.

Create `~/.pw-tools/motion.mjs`:

```js
import { chromium } from "playwright";
const base = "http://127.0.0.1:8123";
const b = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, baseURL: base });
await ctx.request.post("/api/session", { data: { password: "x" } });
await ctx.addInitScript(() => {
  window.EventSource = class extends EventTarget {
    constructor() {
      super();
      window.__es = this;
      setTimeout(() => this.dispatchEvent(new Event("open")), 0);
    }
    close() {}
  };
});
const p = await ctx.newPage();
await p.goto(base);
await p.getByTestId("total-points").waitFor();
const snap = await (await ctx.request.get("/api/streamers")).json();
const first = snap.streamers.find((s) => s.points !== null);
const push = (points) => p.evaluate(([s, login, pts]) => {
  const frame = {
    ...s, pending: false, lastUpdated: Date.now(),
    streamers: s.streamers.map((x) => (x.username === login ? { ...x, points: pts } : x)),
  };
  window.__es.dispatchEvent(new MessageEvent("state", { data: JSON.stringify(frame) }));
}, [snap, first.username, points]);

await push(first.points);          // a complete frame: snaps, becomes "previous"
await p.waitForTimeout(300);
await push(first.points + 5000);   // animates
await p.waitForTimeout(250);
await p.screenshot({ path: "/tmp/motion-check/1-mid-roll.png" });
await p.waitForTimeout(1500);
await p.screenshot({ path: "/tmp/motion-check/2-at-rest.png" });
const balance = await p.getByTestId(`streamer-${first.username}`).getByTestId("balance").textContent();
console.log("balance at rest:", balance, "expected", (first.points + 5000).toLocaleString("en-US"));
await b.close();
```

Run: `cd ~/.pw-tools && . ./env.sh && node motion.mjs`
Expected:
- The log shows the balance at rest equal to the new figure.
- `1-mid-roll.png` shows that card's balance between the old and new figures, with a green `+5,000` above it, and the Total tile mid-roll too.
- `2-at-rest.png` shows the final figures and no float.

Look at both screenshots, then send them to the user with `SendUserFile`. If delivery fails, say where they are. Stop the server afterwards.

- [ ] **Step 4: Report**

Summarise for the user: the commits, the test counts, the screenshots, and anything seen in the browser that the tests did not predict.

---

## Out of this plan

- Slices 3 (live-schedule heatmap) and 4 (Insights) get their own plans.
- There is no user-facing animations toggle. Reduced motion is honoured through the OS setting, as the spec says.
