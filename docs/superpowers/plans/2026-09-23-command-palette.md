# Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Ctrl/⌘+K command palette that finds streamers and drop campaigns, runs miner actions and navigates between screens.

**Architecture:** A pure `buildPalette()` turns the query and app state into ordered groups of typed commands. A `CommandPalette` component renders them with `@mantine/spotlight` and dispatches commands through callbacks from `Shell`. Two small refactors make those callbacks possible: the streamer detail dialog moves from `Dashboard` to `Shell`, and `navigate()` accepts one-shot params.

**Tech Stack:** React 19, Mantine 9.6 (`@mantine/core`, `@mantine/spotlight`), Vitest + Testing Library, TypeScript (strict, `verbatimModuleSyntax`).

**Spec:** `docs/superpowers/specs/2026-09-23-insights-and-palette-design.md`, section "Slice 1: Command palette". This is slice 1 of 4. Slices 2–4 get their own plans.

## Global Constraints

- **Never commit without the user's go-ahead.** Show the task's diff (or diffstat) and wait. Once approved, commit directly on `main`, with no feature branch. Use conventional-commit subjects with an explanatory body, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Comments** describe the current code and why it is the way it is. Don't narrate rejected alternatives, but keep any note that stops a future change from breaking something.
- **`@mantine/spotlight` is pinned exactly to `9.6.0`**, the installed `@mantine/core` version. Its peer dependency on core is exact, so a caret range would drift out of step.
- **Type-only imports** use `import type` / `type` specifiers, because `verbatimModuleSyntax` is on.
- **Mantine overlays work under vitest.** Prefer `data-testid` queries for anything inside the palette. When you do query by role inside an overlay, pass `{ hidden: true }`.
- **Group limit:** Streamers and Campaigns show at most 5 items (`GROUP_LIMIT`). "Go to" lists every matching screen, which is a fixed, short list, and Actions has at most 3 entries.
- Run frontend tests with `pnpm --filter @app/frontend exec vitest run <path>` and the full suite with `pnpm --filter @app/frontend test`. The typecheck and bundle both run in `pnpm --filter @app/frontend build`.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `apps/frontend/src/components/StreamerDetailHost.tsx` | create | Lazily mounts the detail dialog for whichever login `Shell` says is open |
| `apps/frontend/src/lib/screenIntent.ts` | create | One-shot navigation params and the `stamped()` helper screens read them through |
| `apps/frontend/src/lib/campaignMatch.ts` | create | Campaign search predicates, shared by Drops and the palette |
| `apps/frontend/src/lib/palette.ts` | create | `buildPalette()`: the query and state become ordered groups of commands |
| `apps/frontend/src/components/CommandPalette.tsx` | create | Spotlight UI, command dispatch, miner confirmation, header button |
| `apps/frontend/src/app.tsx` | modify | Owns the detail dialog, intents, and mounts the palette and its button |
| `apps/frontend/src/routes/Dashboard.tsx` | modify | Asks `Shell` to open a streamer instead of hosting the dialog |
| `apps/frontend/src/routes/Drops.tsx` | modify | Accepts a `jump` param and uses the shared matchers |
| `apps/frontend/src/routes/Streamers.tsx` | modify | Accepts a `prefill` param |
| `apps/frontend/src/components/AddStreamer.tsx` | modify | `initialValue` and `autoFocus` props |
| `apps/frontend/src/main.tsx` | modify | Imports the spotlight stylesheet |

---

### Task 1: Move the streamer detail dialog from Dashboard to Shell

**Files:**
- Create: `apps/frontend/src/components/StreamerDetailHost.tsx`
- Create: `apps/frontend/src/components/StreamerDetailHost.test.tsx`
- Modify: `apps/frontend/src/routes/Dashboard.tsx:5,16-21,124-137,374-382`
- Modify: `apps/frontend/src/routes/Dashboard.test.tsx:392-411`
- Modify: `apps/frontend/src/app.tsx`

**Interfaces:**
- Produces: `StreamerDetailHost({ login: string | null; onClose: () => void })`.
- Produces: the `Dashboard` prop `onOpenStreamer?: (login: string) => void`.
- Produces: `ScreenProps.openStreamer: (login: string) => void` in `app.tsx`.

- [ ] **Step 1: Write the failing host test**

Create `apps/frontend/src/components/StreamerDetailHost.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderLive } from "../test-utils.js";
import { StreamerDetailHost } from "./StreamerDetailHost.js";

const snapshot = {
  lastUpdated: Date.now(), stale: false, error: null,
  streamers: [
    { username: "beta", displayName: "Beta", points: 20, isOnline: false,
      channelId: "2", pointsEnabled: true,
      gained24h: 0, gainedSince: null, gainedStream: null, spark: [20, 20, 20] },
  ],
};

const empty = {
  series: [], events: [], sessions: [],
  coverage: { live: [], mined: [] }, firstSeen: null, retentionFloor: null,
  gained: null, gainedSince: null,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.startsWith("/api/history") ? empty : snapshot),
  })));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
});
afterEach(() => vi.unstubAllGlobals());

test("shows the dialog for the login it is given", async () => {
  // The dialog is behind React.lazy; warming the import keeps this test
  // waiting on the render rather than on module resolution.
  await import("./StreamerDetailModal.js");
  renderLive(<StreamerDetailHost login="beta" onClose={() => {}} />);
  expect(await screen.findByTestId("detail-title")).toHaveTextContent("Beta");
  expect(await screen.findByTestId("streams-empty")).toBeInTheDocument();
});

test("renders nothing until a login is given", async () => {
  renderLive(<StreamerDetailHost login={null} onClose={() => {}} />);
  // Let the live snapshot land, so an empty screen is not just a slow one.
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(screen.queryByTestId("detail-title")).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend exec vitest run src/components/StreamerDetailHost.test.tsx`
Expected: FAIL, because `./StreamerDetailHost.js` cannot be resolved.

- [ ] **Step 3: Create the host**

Create `apps/frontend/src/components/StreamerDetailHost.tsx`:

```tsx
import { lazy, Suspense, useState } from "react";
import { useLiveState } from "../api/useLiveState.js";

// Split out: the dialog brings recharts, which nearly doubles the bundle,
// and no screen should wait on it to paint.
const StreamerDetailModal = lazy(() =>
  import("./StreamerDetailModal.js")
    .then((m) => ({ default: m.StreamerDetailModal })));

/**
 * The streamer detail dialog, for whichever screen asked for it.
 *
 * Owned by the shell so the command palette can open a streamer over any
 * screen. One dialog for the whole app, not one per card: a fifty-streamer
 * roster would otherwise mount fifty modals to show at most one.
 */
export function StreamerDetailHost({ login, onClose }: {
  login: string | null;
  onClose: () => void;
}) {
  const { snapshot } = useLiveState();
  // Mounted from the first open onward, never before: mounting it up front
  // would fetch the chunk the lazy import exists to defer.
  const [used, setUsed] = useState(false);
  if (login !== null && !used) setUsed(true);
  if (!used) return null;

  return (
    <Suspense fallback={null}>
      <StreamerDetailModal
        streamer={snapshot?.streamers.find((s) => s.username === login) ?? null}
        opened={login !== null}
        onClose={onClose}
      />
    </Suspense>
  );
}
```

- [ ] **Step 4: Run the host test to verify it passes**

Run: `pnpm --filter @app/frontend exec vitest run src/components/StreamerDetailHost.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Change the Dashboard test to expect a callback**

In `apps/frontend/src/routes/Dashboard.test.tsx`, replace the whole test `"opens the clicked streamer's detail dialog"` (lines 392–411) with:

```tsx
test("asks for the clicked streamer's detail dialog", async () => {
  const onOpenStreamer = vi.fn();
  renderLive(<Dashboard onOpenStreamer={onOpenStreamer} />);
  await userEvent.click(await screen.findByTestId("streamer-beta"));
  expect(onOpenStreamer).toHaveBeenCalledWith("beta");
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/routes/Dashboard.test.tsx`
Expected: FAIL. TypeScript isn't checked by vitest, so the test runs, and `onOpenStreamer` is never called.

- [ ] **Step 6: Make Dashboard delegate**

In `apps/frontend/src/routes/Dashboard.tsx` (line numbers are from before this step's edits):

1. Line 5: replace `import { lazy, Suspense, useState, type ReactNode } from "react";` with `import type { ReactNode } from "react";`.
2. Delete lines 16–21 (the comment and the `const StreamerDetailModal = lazy(...)` declaration).
3. Replace the signature and the dialog state (lines 124–137, from `export function Dashboard` through the `openDetail` function's closing `};`) with:

```tsx
export function Dashboard({ loginRequired = false, onSignIn, onOpenStreamer }: {
  loginRequired?: boolean;
  onSignIn?: () => void;
  /** Opens a streamer's detail dialog, which the shell hosts. */
  onOpenStreamer?: (login: string) => void;
} = {}) {
  const { snapshot, loadError } = useLiveState();
  const openDetail = (login: string) => onOpenStreamer?.(login);
```

   Keep the `const [feedOn, toggleFeed] = ...` line and everything after it as it is.
4. Delete the `{detailUsed && ( <Suspense> … </Suspense> )}` block after `<EventsFeed enabled={feedOn} />` (lines 374–382).

The `openDetail(s.username)` calls on the cards stay unchanged.

- [ ] **Step 7: Host the dialog in Shell**

In `apps/frontend/src/app.tsx`:

1. Add the import beside the other component imports:

```tsx
import { StreamerDetailHost } from "./components/StreamerDetailHost.js";
```

2. In `SCREENS`, change the dashboard element to:

```tsx
    element: (p: ScreenProps) => (
      <Dashboard
        loginRequired={p.loginRequired}
        onSignIn={() => p.navigate("account")}
        onOpenStreamer={p.openStreamer}
      />
    ),
```

3. Extend `ScreenProps`:

```tsx
interface ScreenProps {
  loginRequired: boolean;
  navigate: (key: ScreenKey) => void;
  /** Opens a streamer's detail dialog over whatever screen is showing. */
  openStreamer: (login: string) => void;
}
```

4. In `Shell`, after `const [screen, setScreen] = useState<ScreenKey>("dashboard");`, add:

```tsx
  // Which streamer's detail dialog is open. Here rather than on the
  // dashboard so the command palette can open one from any screen.
  const [openLogin, setOpenLogin] = useState<string | null>(null);
```

5. In the `SCREENS[screen].element({...})` call, add `openStreamer: setOpenLogin,`. Directly after that call's closing `)}`, still inside `<AppShell.Main>`, add:

```tsx
        <StreamerDetailHost login={openLogin} onClose={() => setOpenLogin(null)} />
```

- [ ] **Step 8: Run the affected tests and the typecheck**

Run: `pnpm --filter @app/frontend exec vitest run src/routes/Dashboard.test.tsx src/components/StreamerDetailHost.test.tsx src/app.test.tsx`
Expected: PASS.

Run: `pnpm --filter @app/frontend exec tsc -b`
Expected: no output, exit 0.

- [ ] **Step 9: Show the diff, then commit once approved**

```bash
git add apps/frontend/src/components/StreamerDetailHost.tsx \
  apps/frontend/src/components/StreamerDetailHost.test.tsx \
  apps/frontend/src/routes/Dashboard.tsx apps/frontend/src/routes/Dashboard.test.tsx \
  apps/frontend/src/app.tsx
git commit -m "refactor(ui): host the streamer detail dialog in the shell

The dashboard owned the dialog, so nothing outside it could open one.
The shell now holds the open login and renders a StreamerDetailHost;
the dashboard asks for a streamer through onOpenStreamer. Behaviour on
the dashboard is unchanged, and the command palette can open a streamer
over any screen.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One-shot navigation params for Drops and Streamers

**Files:**
- Create: `apps/frontend/src/lib/screenIntent.ts`
- Create: `apps/frontend/src/lib/screenIntent.test.ts`
- Modify: `apps/frontend/src/components/AddStreamer.tsx`
- Modify: `apps/frontend/src/components/AddStreamer.test.tsx`
- Modify: `apps/frontend/src/routes/Streamers.tsx:56,235`
- Modify: `apps/frontend/src/routes/Streamers.test.tsx`
- Modify: `apps/frontend/src/routes/Drops.tsx:560,587`
- Modify: `apps/frontend/src/routes/Drops.test.tsx`
- Modify: `apps/frontend/src/app.tsx`

**Interfaces:**
- Consumes: `ScreenProps` from Task 1.
- Produces, from `lib/screenIntent.ts`:
  - `interface ScreenParams { campaign?: string; prefill?: string }`
  - `interface ScreenIntent { params: ScreenParams; id: number }`
  - `interface Stamped<T> { value: T; id: number }`
  - `function stamped<K extends keyof ScreenParams>(intent: ScreenIntent | null, key: K): Stamped<NonNullable<ScreenParams[K]>> | null`
- Produces: `ScreenProps.navigate: (key: ScreenKey, params?: ScreenParams) => void` and `ScreenProps.intent: ScreenIntent | null`.
- Produces: `Drops({ jump?: Stamped<string> | null })` and `Streamers({ prefill?: Stamped<string> | null })`.
- Produces: `AddStreamer` props `initialValue?: string` and `autoFocus?: boolean`.

- [ ] **Step 1: Write the failing `stamped` tests**

Create `apps/frontend/src/lib/screenIntent.test.ts`:

```ts
import { expect, test } from "vitest";
import { stamped } from "./screenIntent.js";

test("no intent, no param", () => {
  expect(stamped(null, "campaign")).toBeNull();
});

test("an intent without that param gives null", () => {
  expect(stamped({ params: { prefill: "x" }, id: 3 }, "campaign")).toBeNull();
});

test("an intent with the param gives its value and the intent's id", () => {
  expect(stamped({ params: { campaign: "c1" }, id: 7 }, "campaign"))
    .toEqual({ value: "c1", id: 7 });
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/lib/screenIntent.test.ts`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 2: Create `screenIntent.ts`**

```ts
/**
 * Where a navigation should land, beyond the screen itself.
 *
 * One-shot: the shell hands these to the screen for the navigation that
 * carried them only, so going back to a screen later does not replay an
 * old jump or prefill.
 */
export interface ScreenParams {
  /** Drops: the campaign to open and scroll to. */
  campaign?: string;
  /** Streamers: text to put in the add box. */
  prefill?: string;
}

/**
 * One navigation's params, numbered.
 *
 * The id is what a screen reacts to. Two jumps to the same campaign are
 * equal by value, and without the id the second would do nothing.
 */
export interface ScreenIntent {
  params: ScreenParams;
  id: number;
}

/** A single param together with the id of the navigation that carried it. */
export interface Stamped<T> {
  value: T;
  id: number;
}

/** Picks one param out of an intent, or null when it is not there. */
export function stamped<K extends keyof ScreenParams>(
  intent: ScreenIntent | null,
  key: K,
): Stamped<NonNullable<ScreenParams[K]>> | null {
  const value = intent?.params[key];
  if (intent === null || value === undefined) return null;
  return { value: value as NonNullable<ScreenParams[K]>, id: intent.id };
}
```

Run the test from Step 1. Expected: PASS (3 tests).

- [ ] **Step 3: Write the failing AddStreamer and Streamers prefill tests**

Append to `apps/frontend/src/components/AddStreamer.test.tsx`:

```tsx
test("starts with the value it is given, focused when asked", () => {
  render(
    <MantineProvider>
      <AddStreamer onAdd={vi.fn()} initialValue="newbie" autoFocus />
    </MantineProvider>,
  );
  const field = screen.getByLabelText("Add streamer");
  expect(field).toHaveValue("newbie");
  expect(field).toHaveFocus();
});
```

Append to `apps/frontend/src/routes/Streamers.test.tsx`:

```tsx
test("a prefill lands in the add box without adding anything", async () => {
  renderApp(<Streamers prefill={{ value: "newbie", id: 1 }} />);
  const field = await screen.findByLabelText("Add streamer");
  expect(field).toHaveValue("newbie");
  // Adding is a staged draft that still needs Apply: the prefill only
  // saves typing, it must not look the channel up or stage it.
  expect(calls.some((c) => c.url.startsWith("/api/streamers/lookup"))).toBe(false);
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/components/AddStreamer.test.tsx src/routes/Streamers.test.tsx`
Expected: FAIL. Both fields read `""`.

- [ ] **Step 4: Implement the prefill**

In `apps/frontend/src/components/AddStreamer.tsx`, change the signature and the value state to:

```tsx
export function AddStreamer({ onAdd, initialValue = "", autoFocus = false }: {
  onAdd: (username: string) => Promise<void>;
  /** Read once, on mount; remount (via `key`) to apply a new one. */
  initialValue?: string;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
```

Then add `autoFocus={autoFocus}` to the `<TextInput>` props.

In `apps/frontend/src/routes/Streamers.tsx`:

1. Add `import type { Stamped } from "../lib/screenIntent.js";` among the imports.
2. Change line 56 to:

```tsx
export function Streamers({ prefill = null }: {
  /** Text the command palette wants in the add box. */
  prefill?: Stamped<string> | null;
} = {}) {
```

3. Replace line 235 (`<AddStreamer onAdd={add} />`) with:

```tsx
      {/* Keyed to the navigation, so each prefill remounts the box with
          its own text and a plain visit gets an empty one. */}
      <AddStreamer
        key={prefill?.id ?? 0}
        onAdd={add}
        initialValue={prefill?.value}
        autoFocus={prefill !== null}
      />
```

Run the tests from Step 3. Expected: PASS.

- [ ] **Step 5: Write the failing Drops jump tests**

In `apps/frontend/src/routes/Drops.test.tsx`, add these imports at the top:

```tsx
import { MantineProvider } from "@mantine/core";
import { theme } from "../theme.js";
```

Then append:

```tsx
test("a jump opens that campaign and scrolls it into view", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  renderApp(<Drops jump={{ value: "c1", id: 1 }} />);
  // Crate is c1's only drop, and only an opened card shows it.
  expect(await screen.findByText("Crate")).toBeTruthy();
  await waitFor(() => expect(scroll).toHaveBeenCalled());
  expect((scroll.mock.contexts[0] as Element).id).toBe("campaign-c1");
  scroll.mockRestore();
});

test("a jump clears a filter that would hide its campaign", async () => {
  const { rerender } = renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "Beta");
  expect(screen.queryByText("Alpha Campaign")).toBeNull();

  rerender(
    <MantineProvider theme={theme} forceColorScheme="dark">
      <Drops jump={{ value: "c1", id: 1 }} />
    </MantineProvider>,
  );
  expect(await screen.findByText("Alpha Campaign")).toBeTruthy();
  expect(screen.getByLabelText(/filter/i)).toHaveValue("");
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/routes/Drops.test.tsx`
Expected: FAIL on both new tests (no "Crate", and the filter is still "Beta").

- [ ] **Step 6: Implement the jump in Drops**

In `apps/frontend/src/routes/Drops.tsx`:

1. Add `import type { Stamped } from "../lib/screenIntent.js";` among the imports.
2. Change line 560 to:

```tsx
export function Drops({ jump = null }: {
  /** A campaign the command palette wants opened and scrolled to. */
  jump?: Stamped<string> | null;
} = {}) {
```

3. Directly after the `jumpedTo` state declaration (line 587), add:

```tsx
  // The palette's jump, applied once the catalogue is here to jump into.
  // Tracked by id so the same jump is applied once, however often this
  // renders, while a second jump to the same campaign still applies.
  const [appliedJump, setAppliedJump] = useState<number | null>(null);
  // Set alongside a jump; the effect below consumes it after the card has
  // rendered, which is the earliest it can be scrolled to.
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  if (jump !== null && data !== null && jump.id !== appliedJump) {
    setAppliedJump(jump.id);
    // The view and the filter could both hide the campaign being jumped
    // to, and a jump that lands on nothing looks broken.
    setView("all");
    setFilter("");
    setJumpedTo(jump.value);
    setScrollTo(jump.value);
  }
  useEffect(() => {
    if (scrollTo === null) return;
    document.getElementById(`campaign-${scrollTo}`)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
    setScrollTo(null);
  }, [scrollTo]);
```

`view`, `filter` and `data` are declared above line 587, so this block can read them.

Run the Drops tests. Expected: PASS, the whole file.

- [ ] **Step 7: Carry intents through Shell**

In `apps/frontend/src/app.tsx`:

1. Add the imports:

```tsx
import { type ScreenIntent, type ScreenParams, stamped } from "./lib/screenIntent.js";
```

2. Change the `streamers` and `drops` entries in `SCREENS`:

```tsx
  streamers: {
    label: "Streamers",
    element: (p: ScreenProps) => <Streamers prefill={stamped(p.intent, "prefill")} />,
  },
  drops: {
    label: "Drops",
    element: (p: ScreenProps) => <Drops jump={stamped(p.intent, "campaign")} />,
  },
```

3. In `ScreenProps`, change `navigate` and add `intent`:

```tsx
  navigate: (key: ScreenKey, params?: ScreenParams) => void;
  /** The params of the navigation that led here, if it carried any. */
  intent: ScreenIntent | null;
```

4. In `Shell`, after the `openLogin` state, add:

```tsx
  // The params of the latest navigation, tagged with the screen they are
  // for. A navigation without params clears them, which makes them one-shot.
  const [intent, setIntent] = useState<(ScreenIntent & { key: ScreenKey }) | null>(null);
  const intentSeq = useRef(0);
```

5. Replace the `navigate` function with:

```tsx
  const navigate = (key: ScreenKey, params?: ScreenParams) => {
    setScreen(key);
    intentSeq.current += 1;
    setIntent(params === undefined ? null : { key, params, id: intentSeq.current });
    // On mobile the sidebar is a slide-over; leaving it open over the
    // screen the user just chose hides the thing they navigated to. The
    // wide-screen sidebar covers nothing, so it stays as the user set it.
    close();
  };
```

6. In the `SCREENS[screen].element({...})` call, add:

```tsx
          intent: intent?.key === screen ? intent : null,
```

`Sidebar`'s `onNavigate={navigate}` still type-checks: a `(key, params?)` function is assignable to `(key) => void`.

- [ ] **Step 8: Run the affected tests and the typecheck**

Run: `pnpm --filter @app/frontend exec vitest run src/lib/screenIntent.test.ts src/components/AddStreamer.test.tsx src/routes/Streamers.test.tsx src/routes/Drops.test.tsx src/app.test.tsx`
Expected: PASS.

Run: `pnpm --filter @app/frontend exec tsc -b`
Expected: exit 0.

- [ ] **Step 9: Show the diff, then commit once approved**

```bash
git add apps/frontend/src/lib/screenIntent.ts apps/frontend/src/lib/screenIntent.test.ts \
  apps/frontend/src/components/AddStreamer.tsx apps/frontend/src/components/AddStreamer.test.tsx \
  apps/frontend/src/routes/Streamers.tsx apps/frontend/src/routes/Streamers.test.tsx \
  apps/frontend/src/routes/Drops.tsx apps/frontend/src/routes/Drops.test.tsx \
  apps/frontend/src/app.tsx
git commit -m "feat(ui): let a navigation carry one-shot params

navigate() takes optional params that reach only the screen that
navigation was for. Drops opens and scrolls to a campaign given by
{ campaign }, clearing a filter or view that would hide it; Streamers
prefills the add box from { prefill } without staging anything. Each
navigation is numbered, so a repeat jump still applies and a plain
visit replays nothing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `buildPalette()` and the shared campaign matchers

**Files:**
- Create: `apps/frontend/src/lib/campaignMatch.ts`
- Create: `apps/frontend/src/lib/campaignMatch.test.ts`
- Create: `apps/frontend/src/lib/palette.ts`
- Create: `apps/frontend/src/lib/palette.test.ts`
- Modify: `apps/frontend/src/routes/Drops.tsx:162-171` (the local matchers), `:724-738` (their use)

**Interfaces:**
- Produces, from `lib/campaignMatch.ts` (all take an already trimmed and lowercased `needle`):
  - `matchesHeader(c: ResolvedCampaign, needle: string): boolean`
  - `matchesDrop(c: ResolvedCampaign, needle: string): boolean`
  - `matchesCampaign(c: ResolvedCampaign, needle: string): boolean`
- Produces, from `lib/palette.ts`:
  - `type MinerAction = "start" | "stop" | "restart"`
  - `const MINER_LABEL: Record<MinerAction, string>`
  - `type PaletteCommand` (a union over the `kind` values `"screen" | "streamer" | "campaign" | "miner" | "add"`)
  - `interface PaletteItem { id: string; label: string; description?: string; live?: boolean; command: PaletteCommand }`
  - `interface PaletteGroup { label: string; items: PaletteItem[] }`
  - `interface PaletteInput { query; screens; streamers; campaigns; minerState; now }`
  - `const GROUP_LIMIT = 5`
  - `function buildPalette(input: PaletteInput): PaletteGroup[]`
- Item ids are `screen:<key>`, `streamer:<login>`, `campaign:<id>`, `miner:<action>` and `add:<login>`. Task 4 builds test ids from them.

- [ ] **Step 1: Write the failing matcher tests**

Create `apps/frontend/src/lib/campaignMatch.test.ts`:

```ts
import { expect, test } from "vitest";
import type { ResolvedCampaign } from "../components/CampaignCard.js";
import { matchesCampaign, matchesDrop, matchesHeader } from "./campaignMatch.js";

const campaign = {
  id: "c1", name: "Winter Event",
  game: { id: "g1", slug: "rust", displayName: "Rust" },
  startsAt: null, endsAt: null, status: "untouched", complete: false,
  drops: [{ id: "d1", name: "Gilded Helmet", benefits: [], requiredMinutes: 60,
            minutes: 0, status: "not-started" }],
} as unknown as ResolvedCampaign;

test("the header covers the campaign's name and its game", () => {
  expect(matchesHeader(campaign, "winter")).toBe(true);
  expect(matchesHeader(campaign, "rust")).toBe(true);
  expect(matchesHeader(campaign, "helmet")).toBe(false);
});

test("a drop matches by its own name", () => {
  expect(matchesDrop(campaign, "helmet")).toBe(true);
  expect(matchesDrop(campaign, "winter")).toBe(false);
});

test("a campaign matches by any of the three", () => {
  expect(matchesCampaign(campaign, "winter")).toBe(true);
  expect(matchesCampaign(campaign, "rust")).toBe(true);
  expect(matchesCampaign(campaign, "helmet")).toBe(true);
  expect(matchesCampaign(campaign, "apex")).toBe(false);
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/lib/campaignMatch.test.ts`
Expected: FAIL, because the module cannot be resolved.

- [ ] **Step 2: Extract the matchers**

Create `apps/frontend/src/lib/campaignMatch.ts`:

```ts
import type { ResolvedCampaign } from "../components/CampaignCard.js";

// Every function here takes the needle already trimmed and lowercased.

/** Whether a campaign's own name or its game contains the needle. */
export function matchesHeader(c: ResolvedCampaign, needle: string): boolean {
  return c.name.toLowerCase().includes(needle)
    || (c.game?.displayName.toLowerCase().includes(needle) ?? false);
}

/** Whether any drop inside the campaign contains the needle. */
export function matchesDrop(c: ResolvedCampaign, needle: string): boolean {
  return c.drops.some((d) => d.name.toLowerCase().includes(needle));
}

/**
 * Name, game or drop. The game is how most campaigns are found, and the
 * drop is often the only name a player knows: they are hunting a
 * particular skin, not whatever the campaign offering it is called.
 */
export function matchesCampaign(c: ResolvedCampaign, needle: string): boolean {
  return matchesHeader(c, needle) || matchesDrop(c, needle);
}
```

In `apps/frontend/src/routes/Drops.tsx`:

1. Delete the local `matchesHeader` and `matchesDrop` functions and their doc comments (lines 162–171).
2. Add `import { matchesCampaign, matchesDrop, matchesHeader } from "../lib/campaignMatch.js";`. `matchedByDropOnly` keeps using the first two.
3. In the `shown` memo, replace the filter callback and its comment with:

```tsx
        : inScope.filter((c) => matchesCampaign(c, needle));
```

Run: `pnpm --filter @app/frontend exec vitest run src/lib/campaignMatch.test.ts src/routes/Drops.test.tsx`
Expected: PASS.

- [ ] **Step 3: Write the failing `buildPalette` tests**

Create `apps/frontend/src/lib/palette.test.ts`:

```ts
import { expect, test } from "vitest";
import type { ScreenKey } from "../app.js";
import type { ResolvedCampaign } from "../components/CampaignCard.js";
import { GROUP_LIMIT, buildPalette, type PaletteInput } from "./palette.js";

const NOW = 1_800_000_000_000;

const screens: PaletteInput["screens"] = [
  { key: "dashboard" as ScreenKey, label: "Dashboard" },
  { key: "streamers" as ScreenKey, label: "Streamers" },
  { key: "logs" as ScreenKey, label: "Logs" },
];

const streamers: PaletteInput["streamers"] = [
  { username: "alpha", displayName: "Alpha", isOnline: true, viewers: 100 },
  { username: "beta", displayName: "Beta", isOnline: false, viewers: null },
  { username: "betamax", displayName: "BetaMax", isOnline: true, viewers: 5000 },
];

const campaign = (id: string, name: string, extra: Partial<ResolvedCampaign> = {}) => ({
  id, name, game: { id: "g", slug: "g", displayName: "Rust" },
  startsAt: null, endsAt: NOW + 1, status: "untouched", complete: false,
  drops: [{ id: `${id}-d`, name: "Gilded Helmet", benefits: [],
            requiredMinutes: 60, minutes: 0, status: "not-started" }],
  ...extra,
}) as unknown as ResolvedCampaign;

const input = (over: Partial<PaletteInput> = {}): PaletteInput => ({
  query: "", screens, streamers, campaigns: null, minerState: "RUNNING", now: NOW, ...over,
});

const labels = (groups: ReturnType<typeof buildPalette>) => groups.map((g) => g.label);
const ids = (groups: ReturnType<typeof buildPalette>, label: string) =>
  groups.find((g) => g.label === label)?.items.map((i) => i.id) ?? [];

test("with no query: screens, then who is live, then actions", () => {
  const groups = buildPalette(input());
  expect(labels(groups)).toEqual(["Go to", "Live now", "Actions"]);
  expect(ids(groups, "Go to")).toEqual(["screen:dashboard", "screen:streamers", "screen:logs"]);
  // Offline channels are left out until asked for; the busiest comes first.
  expect(ids(groups, "Live now")).toEqual(["streamer:betamax", "streamer:alpha"]);
});

test("with a query: streamers, campaigns, actions, then screens", () => {
  // "a" is in every login, in "Autumn", in "Restart miner" and in "Dashboard".
  const groups = buildPalette(input({ query: "a", campaigns: [campaign("c1", "Autumn")] }));
  expect(labels(groups)).toEqual(["Streamers", "Campaigns", "Actions", "Go to"]);
});

test("groups with no match are left out", () => {
  // "winter" matches only the campaign, and is a valid login to add.
  const groups = buildPalette(input({ query: "winter", campaigns: [campaign("c1", "Winter")] }));
  expect(labels(groups)).toEqual(["Campaigns", "Actions"]);
});

test("a query finds offline streamers too, live ones first", () => {
  const groups = buildPalette(input({ query: "beta" }));
  expect(ids(groups, "Streamers")).toEqual(["streamer:betamax", "streamer:beta"]);
});

test("streamers match on display name as well as login", () => {
  const groups = buildPalette(input({
    query: "max", streamers: [{ username: "bm", displayName: "BetaMax", isOnline: false, viewers: null }],
  }));
  expect(ids(groups, "Streamers")).toEqual(["streamer:bm"]);
});

test("a live streamer is marked live and says how many are watching", () => {
  const [item] = buildPalette(input({ query: "betamax" }))[0].items;
  expect(item.live).toBe(true);
  expect(item.description).toBe("Live · 5.0K viewers");
});

test("search groups stop at the limit", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    username: `chan${i}`, displayName: null, isOnline: false, viewers: null,
  }));
  const groups = buildPalette(input({ query: "chan", streamers: many }));
  expect(ids(groups, "Streamers")).toHaveLength(GROUP_LIMIT);
});

test("campaigns match by name, game or drop; ended ones sink", () => {
  const campaigns = [
    campaign("old", "Autumn", { endsAt: NOW - 1 }),
    campaign("new", "Winter"),
  ];
  expect(ids(buildPalette(input({ query: "winter", campaigns })), "Campaigns")).toEqual(["campaign:new"]);
  expect(ids(buildPalette(input({ query: "rust", campaigns })), "Campaigns"))
    .toEqual(["campaign:new", "campaign:old"]);
  expect(ids(buildPalette(input({ query: "helmet", campaigns })), "Campaigns"))
    .toEqual(["campaign:new", "campaign:old"]);
  const ended = buildPalette(input({ query: "autumn", campaigns }))
    .find((g) => g.label === "Campaigns")!.items[0];
  expect(ended.description).toBe("Rust · ended");
});

test("campaigns not loaded yet give no group rather than an empty one", () => {
  expect(labels(buildPalette(input({ query: "winter" })))).not.toContain("Campaigns");
});

test("the miner offers only what its state allows", () => {
  expect(ids(buildPalette(input({ minerState: "RUNNING" })), "Actions"))
    .toEqual(["miner:stop", "miner:restart"]);
  expect(ids(buildPalette(input({ minerState: "STOPPED" })), "Actions")).toEqual(["miner:start"]);
  expect(labels(buildPalette(input({ minerState: "STARTING" })))).not.toContain("Actions");
  // Unknown is not stopped: offering Start there could start a second miner.
  expect(labels(buildPalette(input({ minerState: null })))).not.toContain("Actions");
});

test("miner actions are searchable by their label", () => {
  const actions = ids(buildPalette(input({ query: "restart" })), "Actions");
  // Miner actions come before the add offer: "restart" is also a valid login.
  expect(actions).toEqual(["miner:restart", "add:restart"]);
});

test("an untracked username can be added", () => {
  expect(ids(buildPalette(input({ query: "newbie" })), "Actions")).toEqual(["add:newbie"]);
  expect(ids(buildPalette(input({ query: "https://twitch.tv/newbie" })), "Actions"))
    .toEqual(["add:newbie"]);
});

test("no add for a tracked channel, whatever its case, or for a non-username", () => {
  expect(ids(buildPalette(input({ query: "ALPHA" })), "Actions")).toEqual([]);
  expect(ids(buildPalette(input({ query: "two words" })), "Actions")).toEqual([]);
});
```

Run: `pnpm --filter @app/frontend exec vitest run src/lib/palette.test.ts`
Expected: FAIL, because `./palette.js` cannot be resolved.

- [ ] **Step 4: Implement `buildPalette`**

Create `apps/frontend/src/lib/palette.ts`:

```ts
import type { StreamerState } from "../api/useLiveState.js";
import type { ScreenKey } from "../app.js";
import type { ResolvedCampaign } from "../components/CampaignCard.js";
import { matchesCampaign } from "./campaignMatch.js";
import { formatViewers } from "./formatViewers.js";
import { TRANSITIONAL, isKnown, isUp } from "./minerState.js";
import { parseStreamerInput } from "./parseStreamerInput.js";

export type MinerAction = "start" | "stop" | "restart";

export const MINER_LABEL: Record<MinerAction, string> = {
  start: "Start miner",
  stop: "Stop miner",
  restart: "Restart miner",
};

/** What choosing an item does. Kept as data so the builder stays pure. */
export type PaletteCommand =
  | { kind: "screen"; screen: ScreenKey }
  | { kind: "streamer"; login: string }
  | { kind: "campaign"; id: string }
  | { kind: "miner"; action: MinerAction }
  | { kind: "add"; login: string };

export interface PaletteItem {
  /** Unique across the palette, e.g. "streamer:alpha". */
  id: string;
  label: string;
  description?: string;
  /** Streamers only: live now. */
  live?: boolean;
  command: PaletteCommand;
}

export interface PaletteGroup {
  label: string;
  items: PaletteItem[];
}

type PaletteStreamer = Pick<StreamerState, "username" | "displayName" | "isOnline" | "viewers">;

export interface PaletteInput {
  query: string;
  screens: ReadonlyArray<{ key: ScreenKey; label: string }>;
  streamers: ReadonlyArray<PaletteStreamer>;
  /** Null until the catalogue has been fetched. */
  campaigns: ReadonlyArray<ResolvedCampaign> | null;
  minerState: string | null;
  now: number;
}

/** The most a search group shows: enough to pick from, few enough to scan. */
export const GROUP_LIMIT = 5;

const isLive = (s: PaletteStreamer) => s.isOnline === true;

/** Live first, the busiest of those first, then by name. */
function byLiveThenName(a: PaletteStreamer, b: PaletteStreamer): number {
  const live = Number(isLive(b)) - Number(isLive(a));
  if (live !== 0) return live;
  const viewers = (b.viewers ?? 0) - (a.viewers ?? 0);
  if (viewers !== 0) return viewers;
  return (a.displayName ?? a.username).localeCompare(b.displayName ?? b.username);
}

function streamerItem(s: PaletteStreamer): PaletteItem {
  const viewers = isLive(s) ? formatViewers(s.viewers ?? null) : null;
  return {
    id: `streamer:${s.username}`,
    label: s.displayName ?? s.username,
    description: !isLive(s) ? undefined : viewers === null ? "Live" : `Live · ${viewers} viewers`,
    live: isLive(s),
    command: { kind: "streamer", login: s.username },
  };
}

function minerItems(state: string | null): PaletteItem[] {
  // Unknown is not stopped, and a transitional miner has no safe action:
  // the same rules the sidebar's MinerDock follows.
  if (!isKnown(state) || TRANSITIONAL.has(state)) return [];
  const actions: MinerAction[] = isUp(state) ? ["stop", "restart"] : ["start"];
  return actions.map((action): PaletteItem => ({
    id: `miner:${action}`,
    label: MINER_LABEL[action],
    command: { kind: "miner", action },
  }));
}

const hasEnded = (c: ResolvedCampaign, now: number) => c.endsAt !== null && c.endsAt <= now;

function campaignItem(c: ResolvedCampaign, now: number): PaletteItem {
  const parts = [c.game?.displayName ?? null, hasEnded(c, now) ? "ended" : null]
    .filter((part): part is string => part !== null);
  return {
    id: `campaign:${c.id}`,
    label: c.name,
    description: parts.length === 0 ? undefined : parts.join(" · "),
    command: { kind: "campaign", id: c.id },
  };
}

const nonEmpty = (groups: PaletteGroup[]) => groups.filter((g) => g.items.length > 0);

/**
 * The palette's contents for a query.
 *
 * With nothing typed it offers somewhere to go, who is live and what the
 * miner can do. Once something is typed, what was searched for comes
 * first and navigation, the least specific match, comes last.
 */
export function buildPalette(input: PaletteInput): PaletteGroup[] {
  const needle = input.query.trim().toLowerCase();
  const matches = (text: string | null) => text !== null && text.toLowerCase().includes(needle);

  const screens = input.screens
    .filter((s) => needle === "" || matches(s.label))
    .map((s): PaletteItem => ({
      id: `screen:${s.key}`, label: s.label, command: { kind: "screen", screen: s.key },
    }));

  const streamers = input.streamers
    .filter((s) => (needle === "" ? isLive(s) : matches(s.username) || matches(s.displayName)))
    .toSorted(byLiveThenName)
    .slice(0, GROUP_LIMIT)
    .map(streamerItem);

  const miner = minerItems(input.minerState).filter((i) => needle === "" || matches(i.label));

  if (needle === "") {
    return nonEmpty([
      { label: "Go to", items: screens },
      { label: "Live now", items: streamers },
      { label: "Actions", items: miner },
    ]);
  }

  const campaigns = (input.campaigns ?? [])
    .filter((c) => matchesCampaign(c, needle))
    .toSorted((a, b) =>
      Number(hasEnded(a, input.now)) - Number(hasEnded(b, input.now))
      || a.name.localeCompare(b.name))
    .slice(0, GROUP_LIMIT)
    .map((c) => campaignItem(c, input.now));

  const login = parseStreamerInput(input.query);
  const tracked = login !== null
    && input.streamers.some((s) => s.username.toLowerCase() === login.toLowerCase());
  const add: PaletteItem[] = login === null || tracked ? [] : [{
    id: `add:${login}`,
    label: `Add “${login}” as a streamer`,
    command: { kind: "add", login },
  }];

  return nonEmpty([
    { label: "Streamers", items: streamers },
    { label: "Campaigns", items: campaigns },
    { label: "Actions", items: [...miner, ...add] },
    { label: "Go to", items: screens },
  ]);
}
```

`Array.prototype.toSorted` needs `lib: ES2023`, which the frontend tsconfig already sets.

Run: `pnpm --filter @app/frontend exec vitest run src/lib/palette.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @app/frontend exec tsc -b`
Expected: exit 0.

- [ ] **Step 6: Show the diff, then commit once approved**

```bash
git add apps/frontend/src/lib/campaignMatch.ts apps/frontend/src/lib/campaignMatch.test.ts \
  apps/frontend/src/lib/palette.ts apps/frontend/src/lib/palette.test.ts \
  apps/frontend/src/routes/Drops.tsx
git commit -m "feat(ui): build the command palette's results from app state

buildPalette() turns a query, the roster, the campaign catalogue and the
miner state into ordered groups of typed commands. With nothing typed
it offers screens, live channels and miner actions; with a query, the
matches come first and navigation last. Miner actions follow the dock's
rules, and an untracked username can be added.

The campaign matchers move out of Drops so both searches agree.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The `CommandPalette` component

**Files:**
- Modify: `apps/frontend/package.json` (dependency)
- Modify: `apps/frontend/src/main.tsx` (stylesheet)
- Create: `apps/frontend/src/components/CommandPalette.tsx`
- Create: `apps/frontend/src/components/CommandPalette.test.tsx`

**Interfaces:**
- Consumes: `buildPalette`, `MINER_LABEL`, `MinerAction`, `PaletteCommand` (Task 3), `ScreenParams` (Task 2), `MinerStatus` from `./MinerStatusBadge.js`, and `CampaignsPayload` from `../routes/Drops.js` (type only).
- Produces:
  - `const palette: { open(): void; close(): void; toggle(): void }`
  - `CommandPalette({ screens, minerState, onMinerChange, onNavigate, onOpenStreamer })`, where
    - `screens: ReadonlyArray<{ key: ScreenKey; label: string }>`
    - `minerState: string | null`
    - `onMinerChange: (status: MinerStatus) => void`
    - `onNavigate: (key: ScreenKey, params?: ScreenParams) => void`
    - `onOpenStreamer: (login: string) => void`
  - `PaletteButton()`, which takes no props.
- Test ids: `palette-<item.id>` on each item, `palette-button`, `palette-confirm-text`, `palette-confirm`, `palette-cancel`, `palette-error`.

- [ ] **Step 1: Add the dependency and its stylesheet**

Run: `pnpm --filter @app/frontend add --save-exact @mantine/spotlight@9.6.0`
Expected: `package.json` gains `"@mantine/spotlight": "9.6.0"`, and `pnpm-lock.yaml` updates.

In `apps/frontend/src/main.tsx`, after the `@mantine/charts/styles.css` import, add:

```tsx
import "@mantine/spotlight/styles.css";
```

- [ ] **Step 2: Write the failing component tests**

Create `apps/frontend/src/components/CommandPalette.test.tsx`:

```tsx
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ScreenKey } from "../app.js";
import { renderLive } from "../test-utils.js";
import { CommandPalette, palette } from "./CommandPalette.js";

const snapshot = {
  lastUpdated: Date.now(), stale: false, error: null,
  streamers: [
    { username: "alpha", displayName: "Alpha", points: 1, isOnline: true, viewers: 120,
      channelId: "1", pointsEnabled: true, gained24h: 0, gainedSince: null,
      gainedStream: null, spark: [] },
    { username: "beta", displayName: "Beta", points: 1, isOnline: false,
      channelId: "2", pointsEnabled: true, gained24h: 0, gainedSince: null,
      gainedStream: null, spark: [] },
  ],
};

const campaigns = {
  campaigns: [{
    id: "c1", name: "Winter Event",
    game: { id: "g1", slug: "rust", displayName: "Rust" },
    startsAt: 1, endsAt: Date.now() + 86_400_000, status: "untouched", complete: false,
    drops: [],
  }],
  catalogueFetchedAt: Date.now(), catalogueStale: false, catalogueAvailable: true,
  catalogueError: null, progressFetchedAt: Date.now(), progressAvailable: true,
};

let calls: Array<{ url: string; init?: RequestInit }>;
let minerFails = false;

beforeEach(() => {
  calls = [];
  minerFails = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("/api/miner/") && minerFails) {
      return { ok: false, status: 500, json: async () => ({ error: "supervisor busy" }) };
    }
    if (url.startsWith("/api/miner/")) {
      return { ok: true, status: 200, json: async () => ({ state: "STOPPED", startedAt: null }) };
    }
    if (url === "/api/campaigns") return { ok: true, status: 200, json: async () => campaigns };
    return { ok: true, status: 200, json: async () => snapshot };
  }));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
});

afterEach(() => {
  // The palette's store is module-level: an open palette would leak into
  // the next test.
  act(() => palette.close());
  vi.unstubAllGlobals();
});

const screens = [
  { key: "dashboard" as ScreenKey, label: "Dashboard" },
  { key: "logs" as ScreenKey, label: "Logs" },
];

function view(minerState: string | null = "RUNNING") {
  const props = {
    screens,
    minerState,
    onMinerChange: vi.fn(),
    onNavigate: vi.fn(),
    onOpenStreamer: vi.fn(),
  };
  renderLive(<CommandPalette {...props} />);
  return props;
}

async function openAndType(text: string) {
  act(() => palette.open());
  const search = await screen.findByPlaceholderText(/search streamers/i);
  // Wait for the live snapshot, which the streamer results are built from.
  await waitFor(() => expect(calls.some((c) => c.url === "/api/streamers")).toBe(true));
  if (text !== "") await userEvent.type(search, text);
  return search;
}

test("with nothing typed it offers screens, live channels and actions", async () => {
  view();
  await openAndType("");
  expect(await screen.findByTestId("palette-streamer:alpha")).toBeInTheDocument();
  expect(screen.queryByTestId("palette-streamer:beta")).toBeNull();
  expect(screen.getByTestId("palette-screen:logs")).toBeInTheDocument();
  expect(screen.getByTestId("palette-miner:stop")).toBeInTheDocument();
});

test("choosing a streamer opens its dialog and closes the palette", async () => {
  const props = view();
  await openAndType("beta");
  await userEvent.click(await screen.findByTestId("palette-streamer:beta"));
  expect(props.onOpenStreamer).toHaveBeenCalledWith("beta");
  await waitFor(() =>
    expect(screen.queryByPlaceholderText(/search streamers/i)).toBeNull());
});

test("choosing a screen navigates there", async () => {
  const props = view();
  await openAndType("logs");
  await userEvent.click(await screen.findByTestId("palette-screen:logs"));
  expect(props.onNavigate).toHaveBeenCalledWith("logs");
});

test("campaigns are fetched on first open, once, and jump to Drops", async () => {
  const props = view();
  await openAndType("winter");
  await userEvent.click(await screen.findByTestId("palette-campaign:c1"));
  expect(props.onNavigate).toHaveBeenCalledWith("drops", { campaign: "c1" });

  await openAndType("");
  expect(calls.filter((c) => c.url === "/api/campaigns")).toHaveLength(1);
});

test("adding an untracked name goes to Streamers with it prefilled", async () => {
  const props = view();
  await openAndType("newbie");
  await userEvent.click(await screen.findByTestId("palette-add:newbie"));
  expect(props.onNavigate).toHaveBeenCalledWith("streamers", { prefill: "newbie" });
});

test("stopping asks first and does nothing until confirmed", async () => {
  const props = view();
  await openAndType("stop");
  await userEvent.click(await screen.findByTestId("palette-miner:stop"));
  expect(await screen.findByTestId("palette-confirm-text"))
    .toHaveTextContent("Stop the miner?");
  expect(calls.some((c) => c.url === "/api/miner/stop")).toBe(false);

  await userEvent.click(screen.getByTestId("palette-confirm"));
  await waitFor(() => expect(props.onMinerChange)
    .toHaveBeenCalledWith({ state: "STOPPED", startedAt: null }));
  expect(calls.find((c) => c.url === "/api/miner/stop")?.init?.method).toBe("POST");
});

test("Escape backs out of a confirmation without closing the palette", async () => {
  view();
  await openAndType("restart");
  await userEvent.click(await screen.findByTestId("palette-miner:restart"));
  await screen.findByTestId("palette-confirm-text");
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByTestId("palette-miner:restart")).toBeInTheDocument();
  expect(screen.queryByTestId("palette-confirm-text")).toBeNull();
});

test("Cancel backs out too", async () => {
  view();
  await openAndType("stop");
  await userEvent.click(await screen.findByTestId("palette-miner:stop"));
  await userEvent.click(await screen.findByTestId("palette-cancel"));
  expect(await screen.findByTestId("palette-miner:stop")).toBeInTheDocument();
});

test("a failed action says why and stays open", async () => {
  minerFails = true;
  view();
  await openAndType("stop");
  await userEvent.click(await screen.findByTestId("palette-miner:stop"));
  await userEvent.click(await screen.findByTestId("palette-confirm"));
  expect(await screen.findByTestId("palette-error")).toHaveTextContent("supervisor busy");
  expect(screen.getByPlaceholderText(/search streamers/i)).toBeInTheDocument();
});

test("starting needs no confirmation", async () => {
  const props = view("STOPPED");
  await openAndType("start");
  await userEvent.click(await screen.findByTestId("palette-miner:start"));
  await waitFor(() => expect(props.onMinerChange).toHaveBeenCalled());
  expect(calls.some((c) => c.url === "/api/miner/start")).toBe(true);
});
```

`api.post` (`apps/frontend/src/api/client.ts`) throws an `Error` whose message is the response body's `error` field, which is why the failure test expects "supervisor busy".

Run: `pnpm --filter @app/frontend exec vitest run src/components/CommandPalette.test.tsx`
Expected: FAIL, because `./CommandPalette.js` cannot be resolved.

- [ ] **Step 3: Implement the component**

Create `apps/frontend/src/components/CommandPalette.tsx`:

```tsx
import { ActionIcon, Button, Group, Kbd, Loader, Text } from "@mantine/core";
import { useMediaQuery, useWindowEvent } from "@mantine/hooks";
import { Spotlight, createSpotlight } from "@mantine/spotlight";
import { IconSearch } from "@tabler/icons-react";
import { useState } from "react";
import { api } from "../api/client.js";
import { useLiveState } from "../api/useLiveState.js";
import type { ScreenKey } from "../app.js";
import {
  MINER_LABEL, buildPalette, type MinerAction, type PaletteCommand,
} from "../lib/palette.js";
import type { ScreenParams } from "../lib/screenIntent.js";
import type { CampaignsPayload } from "../routes/Drops.js";
import type { ResolvedCampaign } from "./CampaignCard.js";
import type { MinerStatus } from "./MinerStatusBadge.js";

/**
 * The palette's own store, so opening it never depends on which component
 * happens to hold a reference: the header button and the shortcut drive
 * the same instance.
 */
const [paletteStore, palette] = createSpotlight();
export { palette };

/** What a miner action will cost, said before it is taken. */
const PROMPT: Record<MinerAction, string> = {
  start: "Starting the miner…",
  stop: "Stop the miner? It will stop collecting points.",
  restart: "Restart the miner? Collection pauses while it comes back up.",
};

interface Pending {
  action: MinerAction;
  running: boolean;
  error: string | null;
}

const LIVE_DOT = (
  <span
    aria-hidden
    style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--tw-live)" }}
  />
);

export function CommandPalette({
  screens, minerState, onMinerChange, onNavigate, onOpenStreamer,
}: {
  screens: ReadonlyArray<{ key: ScreenKey; label: string }>;
  minerState: string | null;
  onMinerChange: (status: MinerStatus) => void;
  onNavigate: (key: ScreenKey, params?: ScreenParams) => void;
  onOpenStreamer: (login: string) => void;
}) {
  const { snapshot } = useLiveState();
  const [query, setQuery] = useState("");
  const [campaigns, setCampaigns] = useState<ResolvedCampaign[] | null>(null);
  const [asked, setAsked] = useState(false);
  // A miner action waiting on confirmation, running, or failed. While set,
  // the list is replaced by the confirmation and the query is ignored.
  const [pending, setPending] = useState<Pending | null>(null);

  // Fetched on the first open rather than on mount: most sessions never
  // open the palette, and the catalogue is the largest payload the app
  // reads. A failed fetch is asked again on the next open.
  const loadCampaigns = () => {
    if (asked) return;
    setAsked(true);
    api.get<CampaignsPayload>("/api/campaigns")
      .then((payload) => setCampaigns(payload.campaigns))
      .catch(() => setAsked(false));
  };

  const run = async (action: MinerAction) => {
    setPending({ action, running: true, error: null });
    try {
      onMinerChange(await api.post<MinerStatus>(`/api/miner/${action}`));
      palette.close();
    } catch (cause) {
      setPending({
        action, running: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const dispatch = (command: PaletteCommand) => {
    switch (command.kind) {
      case "screen": return onNavigate(command.screen);
      case "streamer": return onOpenStreamer(command.login);
      case "campaign": return onNavigate("drops", { campaign: command.id });
      case "add": return onNavigate("streamers", { prefill: command.login });
      case "miner":
        // Stopping costs points, so it is asked about. Starting costs
        // nothing and is simply done.
        if (command.action === "start") void run("start");
        else setPending({ action: command.action, running: false, error: null });
    }
  };

  // Escape backs out of a confirmation instead of closing the palette.
  // Listened for on the window because focus may be on the search box or
  // on an action; Spotlight's own Escape is off while this is showing.
  useWindowEvent("keydown", (event) => {
    if (event.key !== "Escape" || pending === null || pending.running) return;
    event.preventDefault();
    setPending(null);
  });

  const groups = buildPalette({
    query,
    screens,
    streamers: snapshot?.streamers ?? [],
    campaigns,
    minerState,
    now: Date.now(),
  });

  const confirmation = pending !== null && (
    <>
      <Text size="sm" px="md" py="xs" data-testid="palette-confirm-text">
        {PROMPT[pending.action]}
      </Text>
      {pending.error !== null && (
        <Text size="sm" c="red" px="md" pb="xs" role="alert" data-testid="palette-error">
          {pending.error}
        </Text>
      )}
      <Spotlight.Action
        label={pending.error === null ? MINER_LABEL[pending.action] : "Try again"}
        disabled={pending.running}
        rightSection={pending.running ? <Loader size="xs" /> : undefined}
        closeSpotlightOnTrigger={false}
        onClick={() => void run(pending.action)}
        data-testid="palette-confirm"
      />
      <Spotlight.Action
        label="Cancel"
        disabled={pending.running}
        closeSpotlightOnTrigger={false}
        onClick={() => setPending(null)}
        data-testid="palette-cancel"
      />
    </>
  );

  return (
    <Spotlight.Root
      store={paletteStore}
      query={query}
      onQueryChange={setQuery}
      shortcut="mod + K"
      // Ctrl+K is expected to work from inside a text field too.
      tagsToIgnore={[]}
      closeOnEscape={pending === null}
      onSpotlightOpen={loadCampaigns}
      onSpotlightClose={() => { setPending(null); setQuery(""); }}
      scrollable
      maxHeight={420}
    >
      <Spotlight.Search
        placeholder="Search streamers, campaigns, actions…"
        leftSection={<IconSearch size={18} stroke={1.7} />}
      />
      <Spotlight.ActionsList>
        {confirmation || (groups.length === 0
          ? <Spotlight.Empty>Nothing found</Spotlight.Empty>
          : groups.map((group) => (
            <Spotlight.ActionsGroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <Spotlight.Action
                  key={item.id}
                  label={item.label}
                  description={item.description}
                  leftSection={item.live ? LIVE_DOT : undefined}
                  highlightQuery
                  highlightColor="twitch"
                  // A miner action moves on to its confirmation or its
                  // progress, which the palette has to stay open to show.
                  closeSpotlightOnTrigger={item.command.kind !== "miner"}
                  onClick={() => dispatch(item.command)}
                  data-testid={`palette-${item.id}`}
                />
              ))}
            </Spotlight.ActionsGroup>
          )))}
      </Spotlight.ActionsList>
    </Spotlight.Root>
  );
}

/**
 * The palette's visible way in, for anyone who does not know the shortcut.
 *
 * Icon-only below the sidebar's breakpoint, where the header has no room
 * for a label.
 */
export function PaletteButton() {
  const wide = useMediaQuery("(min-width: 48em)", false, { getInitialValueInEffect: false });
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

  if (!wide) {
    return (
      <ActionIcon
        variant="default" aria-label="Search" onClick={palette.open}
        data-testid="palette-button"
      >
        <IconSearch size={16} stroke={1.7} />
      </ActionIcon>
    );
  }
  return (
    <Button
      variant="default" size="xs"
      leftSection={<IconSearch size={14} stroke={1.7} />}
      rightSection={<Group gap={2} wrap="nowrap"><Kbd size="xs">{mod}</Kbd><Kbd size="xs">K</Kbd></Group>}
      onClick={palette.open}
      data-testid="palette-button"
    >
      Search…
    </Button>
  );
}
```

- [ ] **Step 4: Run the component tests**

Run: `pnpm --filter @app/frontend exec vitest run src/components/CommandPalette.test.tsx`
Expected: PASS (10 tests).

If the Escape test fails because Spotlight closes anyway, check that `closeOnEscape` reaches the underlying `Modal`: it's a `ModalProps` field that `SpotlightRootProps` doesn't omit. Don't weaken the test.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @app/frontend exec tsc -b`
Expected: exit 0.

- [ ] **Step 6: Show the diff, then commit once approved**

```bash
git add apps/frontend/package.json pnpm-lock.yaml apps/frontend/src/main.tsx \
  apps/frontend/src/components/CommandPalette.tsx \
  apps/frontend/src/components/CommandPalette.test.tsx
git commit -m "feat(ui): add a command palette component

Spotlight-based palette over buildPalette(): streamers open their
detail dialog, campaigns jump to Drops, an untracked name goes to
Streamers prefilled, and screens navigate. Stop and Restart ask first
inside the palette, where Escape backs out rather than closing; a
failed action says why and stays open. The campaign catalogue is
fetched on the first open only.

@mantine/spotlight is pinned to 9.6.0, the installed core version its
exact peer range requires.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mount the palette in Shell and verify in the browser

**Files:**
- Modify: `apps/frontend/src/app.tsx`
- Modify: `apps/frontend/src/app.test.tsx`

**Interfaces:**
- Consumes: `CommandPalette`, `PaletteButton` (Task 4), and `navigate`, `setOpenLogin`, `setMiner` and `shown` from `Shell` (Tasks 1–2).

- [ ] **Step 1: Write the failing app tests**

Append to `apps/frontend/src/app.test.tsx`:

```tsx
// --- the command palette ---

test("Ctrl+K opens the command palette", async () => {
  stub(false);
  view();
  await screen.findByTestId("miner-state");
  await userEvent.keyboard("{Control>}k{/Control}");
  expect(await screen.findByPlaceholderText(/search streamers/i)).toBeInTheDocument();
});

test("the header's search button opens it too", async () => {
  stub(false);
  view();
  await userEvent.click(await screen.findByTestId("palette-button"));
  expect(await screen.findByPlaceholderText(/search streamers/i)).toBeInTheDocument();
});

test("a screen chosen in the palette is navigated to", async () => {
  stub(false);
  view();
  await userEvent.click(await screen.findByTestId("palette-button"));
  // Logs, because this file's generic fetch stub is shaped to render it.
  await userEvent.type(await screen.findByPlaceholderText(/search streamers/i), "logs");
  await userEvent.click(await screen.findByTestId("palette-screen:logs"));
  expect(await screen.findByTestId("screen-title")).toHaveTextContent("Logs");
});
```

Also add `act(() => palette.close());` to this file's existing `afterEach`, and add these imports:

```tsx
import { palette } from "./components/CommandPalette.js";
```

`act` is already imported from `@testing-library/react`.

Run: `pnpm --filter @app/frontend exec vitest run src/app.test.tsx`
Expected: FAIL. There's no palette mounted, no `palette-button`, and no `screen-title`.

- [ ] **Step 2: Mount it**

In `apps/frontend/src/app.tsx`:

1. Add the import:

```tsx
import { CommandPalette, PaletteButton } from "./components/CommandPalette.js";
```

2. Below `SCREENS`, add:

```tsx
/** Every screen by key and label, for the palette's "Go to" group. */
const SCREEN_LIST = (Object.keys(SCREENS) as ScreenKey[])
  .map((key) => ({ key, label: SCREENS[key].label }));
```

3. Give the header title a test id: change `<Text fw={600}>{SCREENS[screen].label}</Text>` to `<Text fw={600} data-testid="screen-title">{SCREENS[screen].label}</Text>`.
4. In the header's right-hand `<Group>`, add `<PaletteButton />` as its first child, before the connection-dot `<Tooltip>`.
5. Directly after `<StreamerDetailHost … />` in `<AppShell.Main>`, add:

```tsx
        <CommandPalette
          screens={SCREEN_LIST}
          minerState={shown.state}
          onMinerChange={setMiner}
          onNavigate={navigate}
          onOpenStreamer={setOpenLogin}
        />
```

`shown.state` is the state the sidebar's dock acts on, including the boot-check STARTING, so the palette offers exactly what the dock does.

- [ ] **Step 3: Run the whole frontend suite and the build**

Run: `pnpm --filter @app/frontend test`
Expected: all tests pass.

Run: `pnpm --filter @app/frontend build`
Expected: `tsc -b` is clean and `vite build` succeeds. `@mantine/spotlight` goes into the main chunk, which is expected because the palette is mounted at startup.

- [ ] **Step 4: Verify in a real browser**

Follow the project memories on Playwright: source `~/.pw-tools/env.sh`, authenticate with `POST /api/session`, and navigate by clicking sidebar buttons.

```bash
pnpm run build
mkdir -p /tmp/palette-check
DATA_DIR=/tmp/palette-check APP_PASSWORD=x PORT=8123 \
  STATIC_ROOT=./apps/frontend/dist node apps/backend/dist/index.js
```

Leave the server running in the background. Write a throwaway Playwright script, kept outside the repo, that:
1. POSTs `/api/session` with `{ password: "x" }`, then opens `http://localhost:8123/`.
2. Presses `Control+K` and screenshots the open palette.
3. Types `logs`, presses `Enter`, and checks that the header now reads "Logs".
4. Opens the palette again, types `stop`, presses `Enter`, and screenshots the confirmation. Then presses `Escape` and checks that the list is back.

Send both screenshots to the user with `SendUserFile`. Stop the server afterwards.

- [ ] **Step 5: Show the diff, then commit once approved**

```bash
git add apps/frontend/src/app.tsx apps/frontend/src/app.test.tsx
git commit -m "feat(ui): open the command palette with Ctrl+K or the header button

The shell mounts the palette with its navigation, detail dialog and
miner callbacks, and the header gains a Search button that shows the
shortcut. The palette acts on the same shown miner state as the
sidebar's dock.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Out of this plan

These come in later plans:
- The Insights "Go to" entries ("Insights: this week / this month") are added in the Insights plan, which also adds `period` to `ScreenParams`.
- Animated balances, the live-schedule heatmap and the Insights screen each get their own plan.
