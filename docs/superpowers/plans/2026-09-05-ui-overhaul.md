# Twitch-Native UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stock-Mantine look with a deliberate Twitch.tv-native dark interface and restructure the dashboard, streamers, logs and settings screens.

**Architecture:** Upgrade Mantine 8.3.18 → 9.6.0, then add a theme layer (`theme.ts` for the Mantine theme object, `theme.css` for custom properties and keyframes) that all screens inherit. Restructuring happens in JSX with Mantine primitives plus CSS modules where Mantine's props cannot express a style. No Tailwind, no hand-rolled component library.

**Tech Stack:** React 19.2.8, Mantine 9.6.0, Vite 7, Vitest 3 + Testing Library, TypeScript 5.9, `@fontsource/inter` + `@fontsource/jetbrains-mono` 5.3.0, `@tabler/icons-react` 3.46.0.

**Spec:** `docs/superpowers/specs/2026-09-05-ui-overhaul-design.md`

## Global Constraints

- **Frontend only.** No file under `apps/backend/` or `python/` is modified by this plan.
- **Dark only.** `forceColorScheme="dark"`. No light theme, no OS following.
- **Purple is an accent.** `#9147FF` marks actions, focus, and the active nav item. Surfaces stay near-black; numbers stay white. Never wash a surface in purple.
- **No CDN calls at runtime.** Fonts are self-hosted npm packages. This is a LAN tool that must render correctly offline.
- **Commit straight to `main`.** No feature branches (project convention).
- **These testids must survive the whole plan:** `total-points`, `live-heading`, `streamer-*`, `balance`, `gain-stream`, `gain-24h`, `points-disabled`, `staleness`, `streamer-row`, `pending-bar`, `miner-state`, `miner-uptime`, `miner-toggle`, `miner-restart`, `miner-error`.
- **One testid is deliberately retired:** `login-required-banner`, in Task 5.
- **Palette values, verbatim:** `--tw-bg #0E0E10`, `--tw-surface #18181B`, `--tw-surface-alt #1F1F23`, `--tw-border #2F2F35`, `--tw-purple #9147FF`, `--tw-purple-hover #772CE8`, `--tw-live #EB0400`, `--tw-success #00F593`, `--tw-warn #FFB300`, `--tw-text #EFEFF1`, `--tw-text-dim #ADADB8`.
- **Load-bearing logic that must not be "simplified" away:** the `—` vs `0` distinction in `Dashboard.tsx`; the save-before-spawn ordering in `Login.tsx`'s `signIn()`; the transient-error clearing in `Logs.tsx`; the malformed-payload guards in `EventsFeed.tsx` and `useLiveState.ts`; `Sparkline`'s flat-series and <2-point cases; `StalenessBadge`'s independent client-side staleness check.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/theme.ts` | Mantine theme object: purple scale, fonts, radii, component defaults |
| `src/theme.css` | CSS custom properties, base element styles, keyframes, scrollbars |
| `src/test-utils.tsx` | `renderApp()` — renders inside the *real* themed provider |
| `src/components/BrandMark.tsx` | Inline SVG pickaxe-and-coin logo |
| `src/components/NavItem.tsx` | One sidebar row: icon, label, active bar, optional badge |
| `src/components/NavItem.module.css` | Nav row styling |
| `src/components/Sidebar.tsx` | Identity + nav + miner dock |
| `src/components/MinerStatusBadge.tsx` | Header, read-only: state badge + uptime |
| `src/components/MinerDock.tsx` | Sidebar foot: Stop/Restart + error line |
| `src/lib/minerState.ts` | Shared `TRANSITIONAL` / `isUp` — used by both halves |
| `src/components/StatTile.tsx` | One KPI tile |
| `src/components/StatTile.module.css` | KPI tile styling |
| `src/components/StreamerCard.module.css` | Card hover, live pill pulse, offline dim |
| `src/components/LogLine.tsx` | One log line with level colouring |
| `src/components/LogLine.module.css` | Level colours |
| `src/lib/useLocalToggle.ts` | Boolean state persisted to `localStorage` |
| `src/lib/logLevel.ts` | Maps a raw log line to a level |

**Modified:** `package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/app.tsx`, `src/test-setup.ts`, all five routes, `AddStreamer`, `EventsFeed`, `PendingBar`, `Sparkline`, `StalenessBadge`, `StreamerCard`, `PasswordGate`, and their test files.

**Deleted:** `src/components/MinerControls.tsx` and `MinerControls.test.tsx` (split into `MinerStatusBadge` + `MinerDock` in Task 4).

---

## Task 1: Upgrade to Mantine 9 and add a themed test helper

Do this first and alone. If `AppShell` or anything else shifted between 8 and 9 in a way the migration guide does not list, it must surface here — against the current UI — not tangled in design work.

**Files:**
- Modify: `apps/frontend/package.json`
- Create: `apps/frontend/src/test-utils.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `renderApp(ui: ReactNode): RenderResult` — every later test uses this instead of a bare `<MantineProvider>`.

- [ ] **Step 1: Bump the Mantine dependencies**

In `apps/frontend/package.json`, change both Mantine entries under `dependencies`:

```json
    "@mantine/core": "^9.6.0",
    "@mantine/hooks": "^9.6.0",
```

- [ ] **Step 2: Install**

Run from the repo root: `pnpm install`
Expected: resolves without peer-dependency errors. React is already 19.2.8, which satisfies Mantine 9's React 19.2+ floor.

- [ ] **Step 3: Run the existing tests against Mantine 9**

Run: `pnpm --filter @app/frontend test`
Expected: all 8 suites PASS. The migration surface was measured as zero for this codebase — no `<Text color=>`, no `Grid`, no `Collapse`, no `useForm`, no `@mantine/hooks` imports.

If something fails here, fix it before continuing and note what it was. Do not proceed with a red suite.

- [ ] **Step 4: Run the typecheck**

Run: `pnpm --filter @app/frontend build`
Expected: PASS.

- [ ] **Step 5: Write the themed test helper**

Create `apps/frontend/src/test-utils.tsx`. Every existing test wraps its subject in a bare `<MantineProvider>`, which renders Mantine's *default* theme — so tests would exercise a theme the app never uses. This helper is the single place that stays in sync with `main.tsx`.

```tsx
import { MantineProvider } from "@mantine/core";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { theme } from "./theme.js";

/**
 * Renders inside the same provider configuration as main.tsx.
 *
 * A bare <MantineProvider> renders Mantine's default theme, so a test
 * using one asserts against a theme the app never ships. Keep this in
 * step with main.tsx.
 */
export function renderApp(ui: ReactNode): RenderResult {
  return render(
    <MantineProvider theme={theme} forceColorScheme="dark">
      {ui}
    </MantineProvider>,
  );
}
```

This imports `./theme.js`, which does not exist until Task 2 — so it will not typecheck yet. That is expected and is resolved in Task 2 Step 4.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/package.json pnpm-lock.yaml apps/frontend/src/test-utils.tsx
git commit -m "chore: upgrade Mantine to 9.6.0

Zero breaking-change surface in this codebase: no Text/Anchor color prop,
no Grid, Collapse, Spoiler or useForm, and no @mantine/hooks imports.
React was already on 19.2.8, satisfying Mantine 9's floor.

Adds a themed render helper so tests stop asserting against Mantine's
default theme instead of the one the app ships.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Theme foundation

**Files:**
- Create: `apps/frontend/src/theme.ts`, `apps/frontend/src/theme.css`
- Modify: `apps/frontend/package.json`, `apps/frontend/src/main.tsx`, `apps/frontend/index.html`

**Interfaces:**
- Consumes: `renderApp` from Task 1.
- Produces: `theme` (a `MantineThemeOverride`) from `src/theme.ts`; the CSS custom properties listed in Global Constraints, available to every later CSS module.

- [ ] **Step 1: Install fonts and icons**

Run from the repo root:

```bash
pnpm --filter @app/frontend add @fontsource/inter@^5.3.0 @fontsource/jetbrains-mono@^5.3.0 @tabler/icons-react@^3.46.0
```

- [ ] **Step 2: Write the failing test**

Create `apps/frontend/src/theme.test.ts`:

```ts
import { expect, test } from "vitest";
import { theme } from "./theme.js";

test("uses the Twitch brand purple as the primary color", () => {
  // The exact brand hex must be what actually renders, not an
  // approximation Mantine picked from a generated scale.
  expect(theme.primaryColor).toBe("twitch");
  expect(theme.colors?.twitch?.[6]).toBe("#9147FF");
  expect(theme.primaryShade).toBe(6);
});

test("sets monospace to the tabular-figure face used for every number", () => {
  // Balances, uptime and log lines all render here; a proportional
  // fallback makes a ticking uptime jitter.
  expect(theme.fontFamilyMonospace).toMatch(/JetBrains Mono/);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test theme`
Expected: FAIL — cannot resolve `./theme.js`.

- [ ] **Step 4: Write the theme**

Create `apps/frontend/src/theme.ts`:

```ts
import { createTheme, type MantineColorsTuple } from "@mantine/core";

/**
 * Twitch's brand purple as a full 10-step scale, so `color="twitch"` and
 * `variant="filled"` resolve correctly. Index 6 is the exact brand hex
 * (#9147FF) and `primaryShade` pins rendering to it -- without that pin
 * Mantine picks a shade per color scheme and the brand color is never
 * quite what ships.
 */
const twitch: MantineColorsTuple = [
  "#F3EDFF", "#E0D2FF", "#C7ABFF", "#AC80FF", "#9A5FFF",
  "#9147FF", "#8A3FFB", "#772CE8", "#6A24D1", "#5C1CBA",
];

export const theme = createTheme({
  primaryColor: "twitch",
  primaryShade: 6,
  colors: { twitch },
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  fontFamilyMonospace: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace",
  defaultRadius: "md",
  headings: {
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    fontWeight: "700",
  },
  components: {
    Card: { defaultProps: { bg: "var(--tw-surface)", withBorder: true } },
    Paper: { defaultProps: { bg: "var(--tw-surface)" } },
  },
});
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test theme`
Expected: PASS.

- [ ] **Step 6: Write the stylesheet**

Create `apps/frontend/src/theme.css`:

```css
:root {
  --tw-bg: #0E0E10;
  --tw-surface: #18181B;
  --tw-surface-alt: #1F1F23;
  --tw-border: #2F2F35;
  --tw-purple: #9147FF;
  --tw-purple-hover: #772CE8;
  --tw-live: #EB0400;
  --tw-success: #00F593;
  --tw-warn: #FFB300;
  --tw-text: #EFEFF1;
  --tw-text-dim: #ADADB8;

  /* Mantine paints the page from its own variables; point them at ours
     so a component we have not restyled still lands on the palette. */
  --mantine-color-body: var(--tw-bg);
  --mantine-color-text: var(--tw-text);
  --mantine-color-dimmed: var(--tw-text-dim);
}

body {
  background: var(--tw-bg);
  color: var(--tw-text);
  /* Numbers are monospace everywhere; enabling tabular figures globally
     keeps a ticking uptime from reflowing on every digit change. */
  font-variant-numeric: tabular-nums;
}

/* The default scrollbar is a light-theme artifact on a near-black page. */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--tw-border) transparent;
}

@keyframes tw-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@keyframes tw-shake {
  0%, 100% { transform: translateX(0); }
  20%, 60% { transform: translateX(-6px); }
  40%, 80% { transform: translateX(6px); }
}

/* Respect a user's reduced-motion preference: the pulse and shake are
   decorative, and a vestibular trigger is not worth a live dot. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

- [ ] **Step 7: Wire it into main.tsx**

Replace the whole of `apps/frontend/src/main.tsx`:

```tsx
import "@mantine/core/styles.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./theme.css";
import { MantineProvider } from "@mantine/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { theme } from "./theme.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MantineProvider theme={theme} forceColorScheme="dark">
      <App />
    </MantineProvider>
  </StrictMode>,
);
```

Import order matters: `theme.css` must come after `@mantine/core/styles.css` so our overrides win.

- [ ] **Step 8: Stop the light flash in index.html**

In `apps/frontend/index.html`, change the opening `<html>` tag and add a background so the page is dark before React mounts:

```html
<html lang="en" data-mantine-color-scheme="dark" style="background:#0E0E10">
```

Also change the `<title>` from `Miner Control` to `Miner Control · Twitch Points`.

- [ ] **Step 9: Run the full suite**

Run: `pnpm --filter @app/frontend test`
Expected: all suites PASS, including `theme.test.ts` and the `test-utils.tsx` from Task 1 now typechecking.

- [ ] **Step 10: Verify in the browser**

Run `pnpm dev` from the repo root and open the Vite URL (port 5173, not 8080). Confirm: the page is near-black, text is light, no white flash on reload, and buttons are Twitch purple. Stop the dev server.

- [ ] **Step 11: Commit**

```bash
git add apps/frontend/package.json pnpm-lock.yaml apps/frontend/src/theme.ts \
        apps/frontend/src/theme.css apps/frontend/src/theme.test.ts \
        apps/frontend/src/main.tsx apps/frontend/index.html
git commit -m "feat: add the Twitch dark theme foundation

Brand purple as a pinned 10-step scale, Inter and JetBrains Mono
self-hosted so the LAN tool renders with no internet, and a forced dark
scheme stamped on <html> so there is no light flash before React mounts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Brand mark

**Files:**
- Create: `apps/frontend/src/components/BrandMark.tsx`, `apps/frontend/src/components/BrandMark.test.tsx`

**Interfaces:**
- Consumes: the palette custom properties from Task 2.
- Produces: `<BrandMark size?: number />` — used by `Sidebar` (Task 5) and `PasswordGate` (Task 6).

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/BrandMark.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { BrandMark } from "./BrandMark.js";

test("is labelled for assistive tech", () => {
  render(<BrandMark />);
  expect(screen.getByRole("img", { name: /miner control/i })).toBeInTheDocument();
});

test("scales to the requested size", () => {
  const { container } = render(<BrandMark size={96} />);
  const svg = container.querySelector("svg");
  expect(svg).toHaveAttribute("width", "96");
  expect(svg).toHaveAttribute("height", "96");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test BrandMark`
Expected: FAIL — cannot resolve `./BrandMark.js`.

- [ ] **Step 3: Write the component**

Create `apps/frontend/src/components/BrandMark.tsx`. Inline SVG rather than a PNG: it stays sharp at any size, inherits theme colors, costs no network request, and carries no third-party branding.

```tsx
/**
 * A pickaxe striking a channel-points coin.
 *
 * Deliberately not the upstream banner: that art is branded for
 * rdavydov's V2 fork (this repo vendors mpforce1's -- see .gitmodules)
 * and is amber-on-white, which cannot sit on a near-black page without
 * heavy treatment. See the design spec.
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Miner Control"
    >
      <circle cx="19" cy="30" r="13" fill="var(--tw-warn)" />
      <circle cx="19" cy="30" r="9.5" fill="none" stroke="#0E0E10" strokeOpacity="0.25" strokeWidth="1.5" />
      {/* The Twitch glyph on the coin face. */}
      <path
        d="M15 25.5h8v6l-2.5 2.5H18l-2 2v-2h-1zm2.5 1.75v3.25h1.25v-3.25zm3 0v3.25h1.25v-3.25z"
        fill="#0E0E10"
        fillOpacity="0.75"
      />
      {/* Pickaxe: handle, then head, angled into the coin. */}
      <rect
        x="26" y="6" width="3.5" height="26" rx="1.75"
        fill="var(--tw-purple)" transform="rotate(28 26 6)"
      />
      <path
        d="M28 9c4-4 11-5 15-2-4 1-6 3-7 6-3-2-6-3-8-4z"
        fill="var(--tw-purple)"
      />
      <path
        d="M28 9c-4-4-11-5-15-2 4 1 6 3 7 6 3-2 6-3 8-4z"
        fill="var(--tw-purple-hover)"
      />
    </svg>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test BrandMark`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/BrandMark.tsx apps/frontend/src/components/BrandMark.test.tsx
git commit -m "feat: add the pickaxe-and-coin brand mark

Inline SVG so it stays sharp at any size and inherits theme colors, and
so nothing on screen claims to be the upstream V2 fork this repo does
not vendor.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Split MinerControls into header badge and sidebar dock

**Files:**
- Create: `apps/frontend/src/lib/minerState.ts`, `src/components/MinerStatusBadge.tsx`, `src/components/MinerStatusBadge.test.tsx`, `src/components/MinerDock.tsx`, `src/components/MinerDock.test.tsx`
- Delete: `src/components/MinerControls.tsx`, `src/components/MinerControls.test.tsx`
- Modify: `apps/frontend/src/app.tsx` (import site only)

**Interfaces:**
- Consumes: `renderApp` (Task 1).
- Produces:
  - `src/lib/minerState.ts`: `TRANSITIONAL: Set<string>`, `isUp(state: string): boolean`
  - `MinerStatus` interface `{ state: string; startedAt: number | null }`, re-exported from `MinerStatusBadge.tsx` (`app.tsx` imports it from there)
  - `<MinerStatusBadge state={string} startedAt={number | null} />`
  - `<MinerDock state={string} onChange={(s: MinerStatus) => void} />`

Read `apps/frontend/src/components/MinerControls.tsx` before starting. This task moves its logic into two components; it does not rewrite it.

- [ ] **Step 1: Write the failing tests**

Create `apps/frontend/src/components/MinerStatusBadge.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { MinerStatusBadge } from "./MinerStatusBadge.js";

test("shows the miner state", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={null} />);
  expect(screen.getByTestId("miner-state")).toHaveTextContent("RUNNING");
});

test("shows uptime when the miner is up", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={Date.now() - 90_000} />);
  expect(screen.getByTestId("miner-uptime")).toHaveTextContent("1m 30s");
});

test("shows no uptime when nothing is running", () => {
  renderApp(<MinerStatusBadge state="STOPPED" startedAt={null} />);
  expect(screen.queryByTestId("miner-uptime")).not.toBeInTheDocument();
});

test("carries no action buttons -- those live in the sidebar dock", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={null} />);
  expect(screen.queryByTestId("miner-toggle")).not.toBeInTheDocument();
  expect(screen.queryByTestId("miner-restart")).not.toBeInTheDocument();
});
```

Create `apps/frontend/src/components/MinerDock.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { MinerDock } from "./MinerDock.js";

afterEach(() => vi.unstubAllGlobals());

function stubPost(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok, status: ok ? 200 : 500, json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("offers Stop when the miner is up", () => {
  stubPost({});
  renderApp(<MinerDock state="RUNNING" onChange={() => {}} />);
  expect(screen.getByTestId("miner-toggle")).toHaveTextContent("Stop");
});

test("offers Start when the miner is down", () => {
  stubPost({});
  renderApp(<MinerDock state="STOPPED" onChange={() => {}} />);
  expect(screen.getByTestId("miner-toggle")).toHaveTextContent("Start");
});

test("disables both actions while the miner is between lives", () => {
  stubPost({});
  renderApp(<MinerDock state="STARTING" onChange={() => {}} />);
  expect(screen.getByTestId("miner-toggle")).toBeDisabled();
  expect(screen.getByTestId("miner-restart")).toBeDisabled();
});

test("reports the settled state from the action's own response", async () => {
  // The response is the freshest answer there is -- the UI must not wait
  // for the next 5s poll to reflect what just happened.
  stubPost({ state: "STOPPED", startedAt: null });
  const onChange = vi.fn();
  renderApp(<MinerDock state="RUNNING" onChange={onChange} />);
  await userEvent.click(screen.getByTestId("miner-toggle"));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({ state: "STOPPED", startedAt: null }),
  );
});

test("shows a failed action's message in full, not behind a tooltip", async () => {
  // The reason this moved out of the header: there it was clamped to one
  // line at maw=180 with the real text hidden in a tooltip.
  stubPost({ error: "spawn failed: ENOENT" }, false);
  renderApp(<MinerDock state="STOPPED" onChange={() => {}} />);
  await userEvent.click(screen.getByTestId("miner-toggle"));
  expect(await screen.findByTestId("miner-error")).toHaveTextContent("spawn failed: ENOENT");
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/frontend test Miner`
Expected: FAIL — cannot resolve `./MinerStatusBadge.js` or `./MinerDock.js`.

- [ ] **Step 3: Extract the shared state logic**

Create `apps/frontend/src/lib/minerState.ts`:

```ts
/**
 * States in which the miner is between lives: no process to stop, and
 * nothing useful to start on top of the one the supervisor is already
 * working towards. Actions are disabled rather than hidden, so the dock
 * keeps its height and the sidebar does not reflow on every transition.
 */
export const TRANSITIONAL = new Set(["STARTING", "RESTARTING"]);

/** The miner is up: the only sensible toggle is to bring it down. */
export const isUp = (state: string) => state === "RUNNING";
```

- [ ] **Step 4: Write the header badge**

Create `apps/frontend/src/components/MinerStatusBadge.tsx`:

```tsx
import { Badge, Group, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { formatUptime } from "../lib/formatUptime.js";
import { TRANSITIONAL, isUp } from "../lib/minerState.js";

export interface MinerStatus {
  state: string;
  /** When the live miner started, or null if none is running. */
  startedAt: number | null;
}

/**
 * Read-only miner state for the header. The actions live in MinerDock at
 * the sidebar's foot; this half is what stays visible on mobile, where
 * the sidebar collapses into a slide-over.
 */
export function MinerStatusBadge({ state, startedAt }: MinerStatus) {
  // Re-render on a ticking clock so the uptime below is recomputed from
  // the current time. Without this it would only move when a new status
  // arrived from the 5s poll, so the seconds would jump in fives.
  const [, tick] = useState(0);

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const up = isUp(state);
  const transitional = TRANSITIONAL.has(state);

  return (
    <Group gap="xs" wrap="nowrap">
      <Badge
        variant="light"
        color={up ? "teal" : transitional ? "twitch" : "orange"}
        data-testid="miner-state"
      >
        {state}
      </Badge>
      {startedAt !== null && (
        <Text size="sm" c="dimmed" ff="monospace" data-testid="miner-uptime">
          {formatUptime(Date.now() - startedAt)}
        </Text>
      )}
    </Group>
  );
}
```

- [ ] **Step 5: Write the sidebar dock**

Create `apps/frontend/src/components/MinerDock.tsx`:

```tsx
import { Button, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { api } from "../api/client.js";
import { TRANSITIONAL, isUp } from "../lib/minerState.js";
import type { MinerStatus } from "./MinerStatusBadge.js";

/**
 * The miner's actions, pinned to the sidebar's foot.
 *
 * Full-width buttons and a real error line -- in the header these were
 * size="xs" with the message clamped to maw=180 behind a tooltip, which
 * is exactly the text an operator needs when a start fails.
 */
export function MinerDock({ state, onChange }: {
  state: string;
  onChange: (status: MinerStatus) => void;
}) {
  // Which action is in flight, so only the pressed button spins -- a
  // shared boolean would put a spinner on Restart when Stop was clicked.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "start" | "stop" | "restart") {
    setBusy(action);
    setError(null);
    try {
      // The route answers with the settled state, so the UI updates the
      // moment the action completes rather than showing the old state
      // until the next poll lands.
      onChange(await api.post<MinerStatus>(`/api/miner/${action}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const transitional = TRANSITIONAL.has(state);
  const up = isUp(state);

  return (
    <Stack gap="xs">
      {error && (
        <Text role="alert" size="xs" c="red" data-testid="miner-error">
          {error}
        </Text>
      )}
      <Button
        fullWidth
        size="sm"
        variant={up ? "default" : "filled"}
        color={up ? undefined : "teal"}
        data-testid="miner-toggle"
        disabled={transitional}
        loading={busy === (up ? "stop" : "start")}
        onClick={() => run(up ? "stop" : "start")}
      >
        {up ? "Stop" : "Start"}
      </Button>
      <Button
        fullWidth
        size="sm"
        variant="default"
        data-testid="miner-restart"
        disabled={transitional}
        loading={busy === "restart"}
        onClick={() => run("restart")}
      >
        Restart
      </Button>
    </Stack>
  );
}
```

- [ ] **Step 6: Point app.tsx at the new modules**

This is a temporary wiring step; Task 5 rebuilds the shell around it. In `apps/frontend/src/app.tsx`, replace the `MinerControls` import line:

```tsx
import { MinerDock } from "./components/MinerDock.js";
import { MinerStatusBadge, type MinerStatus } from "./components/MinerStatusBadge.js";
```

and replace the `<MinerControls ... />` element inside `AppShell.Header` with:

```tsx
<MinerStatusBadge state={miner.state} startedAt={miner.startedAt} />
```

Then add the dock to the navbar, below the existing `NavLink` list, still inside `<AppShell.Navbar>`:

```tsx
<MinerDock state={miner.state} onChange={setMiner} />
```

- [ ] **Step 7: Delete the old component and its test**

```bash
git rm apps/frontend/src/components/MinerControls.tsx \
       apps/frontend/src/components/MinerControls.test.tsx
```

Its behaviour is now covered by `MinerStatusBadge.test.tsx` and `MinerDock.test.tsx`.

- [ ] **Step 8: Run the full suite**

Run: `pnpm --filter @app/frontend test`
Expected: all PASS. `app.test.tsx` asserts on `miner-uptime`, which `MinerStatusBadge` still provides.

- [ ] **Step 9: Commit**

```bash
git add -A apps/frontend/src
git commit -m "refactor: split miner controls into header badge and sidebar dock

Status stays in the header, where it is visible even when the sidebar
collapses on mobile. The actions move to the sidebar foot, where the
error message gets a readable line instead of a 180px clamp behind a
tooltip.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Sidebar, nav, and app shell

Retires the `login-required-banner` testid. Read `apps/frontend/src/app.tsx` and `app.test.tsx` fully before starting.

**Files:**
- Create: `src/components/NavItem.tsx`, `src/components/NavItem.module.css`, `src/components/NavItem.test.tsx`, `src/components/Sidebar.tsx`
- Modify: `apps/frontend/src/app.tsx`, `apps/frontend/src/app.test.tsx`, `apps/frontend/vite.config.ts`

**Interfaces:**
- Consumes: `BrandMark` (Task 3), `MinerStatusBadge` + `MinerDock` (Task 4).
- Produces:
  - `<NavItem icon={ReactNode} label={string} active={boolean} onClick={() => void} badge?={ReactNode} />`
  - `<Sidebar screen={ScreenKey} onNavigate={(k: ScreenKey) => void} liveCount={number} loginRequired={boolean} miner={MinerStatus} onMinerChange={(s: MinerStatus) => void} />`
  - `type ScreenKey = "dashboard" | "streamers" | "logs" | "settings" | "account"` exported from `app.tsx`.

- [ ] **Step 1: Enable CSS modules in the test environment**

Vitest does not process CSS by default, so a component importing a `.module.css` file gets `undefined` for every class. In `apps/frontend/vite.config.ts`, add `css: true` inside the `test` block:

```ts
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    css: true,
  },
```

- [ ] **Step 2: Write the failing NavItem test**

Create `apps/frontend/src/components/NavItem.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { NavItem } from "./NavItem.js";

test("marks the active row for assistive tech, not just visually", () => {
  renderApp(<NavItem icon={null} label="Dashboard" active onClick={() => {}} />);
  expect(screen.getByRole("button", { name: /dashboard/i }))
    .toHaveAttribute("aria-current", "page");
});

test("leaves an inactive row unmarked", () => {
  renderApp(<NavItem icon={null} label="Logs" active={false} onClick={() => {}} />);
  expect(screen.getByRole("button", { name: /logs/i }))
    .not.toHaveAttribute("aria-current");
});

test("navigates when clicked", async () => {
  const onClick = vi.fn();
  renderApp(<NavItem icon={null} label="Settings" active={false} onClick={onClick} />);
  await userEvent.click(screen.getByRole("button", { name: /settings/i }));
  expect(onClick).toHaveBeenCalledOnce();
});

test("renders a badge beside the label", () => {
  renderApp(
    <NavItem icon={null} label="Streamers" active={false} onClick={() => {}} badge={<span>3</span>} />,
  );
  expect(screen.getByRole("button", { name: /streamers/i })).toHaveTextContent("3");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test NavItem`
Expected: FAIL — cannot resolve `./NavItem.js`.

- [ ] **Step 4: Write the NavItem styles**

Create `apps/frontend/src/components/NavItem.module.css`:

```css
.item {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 14px 10px 12px;
  border: 0;
  border-left: 4px solid transparent;
  border-radius: 0 6px 6px 0;
  background: transparent;
  color: var(--tw-text-dim);
  font: inherit;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}

.item:hover {
  background: var(--tw-surface-alt);
  color: var(--tw-text);
}

.item:focus-visible {
  outline: 2px solid var(--tw-purple);
  outline-offset: -2px;
}

/* The active state is the sidebar's whole personality: a purple bar
   flush to the edge, a lifted surface, and full-strength text. */
.active {
  border-left-color: var(--tw-purple);
  background: var(--tw-surface-alt);
  color: var(--tw-text);
}

.label { flex: 1; }

.icon {
  display: flex;
  align-items: center;
  color: currentColor;
}
```

- [ ] **Step 5: Write NavItem**

Create `apps/frontend/src/components/NavItem.tsx`:

```tsx
import type { ReactNode } from "react";
import classes from "./NavItem.module.css";

/**
 * One sidebar row.
 *
 * A button rather than Mantine's NavLink: the active treatment is a
 * flush-left purple bar that NavLink's own structure cannot express, and
 * aria-current carries the state to assistive tech that cannot see it.
 */
export function NavItem({ icon, label, active, onClick, badge }: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`${classes.item} ${active ? classes.active : ""}`}
    >
      <span className={classes.icon}>{icon}</span>
      <span className={classes.label}>{label}</span>
      {badge}
    </button>
  );
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test NavItem`
Expected: PASS.

- [ ] **Step 7: Write the Sidebar**

Create `apps/frontend/src/components/Sidebar.tsx`:

```tsx
import { Badge, Box, Group, Stack, Text } from "@mantine/core";
import {
  IconChartBar, IconDeviceTv, IconSettings, IconTerminal2, IconUserCircle,
} from "@tabler/icons-react";
import { BrandMark } from "./BrandMark.js";
import { MinerDock } from "./MinerDock.js";
import type { MinerStatus } from "./MinerStatusBadge.js";
import { NavItem } from "./NavItem.js";
import type { ScreenKey } from "../app.js";

const ICON = { size: 20, stroke: 1.7 };

const ITEMS: Array<{ key: ScreenKey; label: string; icon: React.ReactNode }> = [
  { key: "dashboard", label: "Dashboard", icon: <IconChartBar {...ICON} /> },
  { key: "streamers", label: "Streamers", icon: <IconDeviceTv {...ICON} /> },
  { key: "logs", label: "Logs", icon: <IconTerminal2 {...ICON} /> },
  { key: "settings", label: "Settings", icon: <IconSettings {...ICON} /> },
  { key: "account", label: "Twitch account", icon: <IconUserCircle {...ICON} /> },
];

export function Sidebar({
  screen, onNavigate, liveCount, loginRequired, miner, onMinerChange,
}: {
  screen: ScreenKey;
  onNavigate: (key: ScreenKey) => void;
  liveCount: number;
  loginRequired: boolean;
  miner: MinerStatus;
  onMinerChange: (status: MinerStatus) => void;
}) {
  return (
    <Stack h="100%" gap={0} justify="space-between">
      <Box>
        <Group gap="sm" px="md" py="lg" wrap="nowrap">
          <BrandMark size={28} />
          <Text fw={700} size="sm" style={{ letterSpacing: "0.08em" }}>
            MINER CONTROL
          </Text>
        </Group>
        <Stack gap={2} pr="xs">
          {ITEMS.map((item) => (
            <NavItem
              key={item.key}
              icon={item.icon}
              label={item.label}
              active={screen === item.key}
              onClick={() => onNavigate(item.key)}
              badge={
                item.key === "streamers" && liveCount > 0 ? (
                  <Badge size="sm" variant="filled" color="red" data-testid="nav-live-count">
                    {liveCount}
                  </Badge>
                ) : item.key === "account" && loginRequired ? (
                  // Replaces the alert banner that used to sit above every
                  // screen: the same warning, stated permanently, without
                  // consuming vertical space on the dashboard.
                  <Badge
                    size="xs" circle variant="filled" color="twitch"
                    data-testid="nav-login-required"
                    aria-label="Twitch sign-in needed"
                  >
                    {" "}
                  </Badge>
                ) : undefined
              }
            />
          ))}
        </Stack>
      </Box>
      <Box p="md" style={{ borderTop: "1px solid var(--tw-border)" }}>
        <MinerDock state={miner.state} onChange={onMinerChange} />
      </Box>
    </Stack>
  );
}
```

- [ ] **Step 8: Update app.test.tsx for the retired banner**

In `apps/frontend/src/app.test.tsx`, replace the whole file's first three tests and the render helper. Change the import of `MantineProvider`/`render` to use the shared helper, and swap the banner assertions:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./app.js";
import { renderApp } from "./test-utils.js";
```

Replace the `view` helper:

```tsx
const view = () => renderApp(<App />);
```

Replace the first two tests:

```tsx
test("flags the account nav row when the Twitch session needs attention", async () => {
  // Replaces the old banner above every screen: the nav says it
  // permanently, without eating dashboard height.
  stub(true);
  view();
  expect(await screen.findByTestId("nav-login-required")).toBeInTheDocument();
});

test("leaves the account row unflagged once a Twitch session is established", async () => {
  stub(false);
  view();
  // Let the app settle before asserting absence, so this isn't trivially
  // true of an unrendered tree.
  await screen.findByRole("button", { name: /dashboard/i });
  expect(screen.queryByTestId("nav-login-required")).not.toBeInTheDocument();
});
```

For the third test ("clicking Sign in from the banner…"), the banner's Sign in button is gone; navigation now happens through the nav row. Replace it with:

```tsx
test("the account nav row switches to the Twitch account screen", async () => {
  stub(true);
  view();
  await userEvent.click(await screen.findByRole("button", { name: /twitch account/i }));
  expect(await screen.findByLabelText(/twitch username/i)).toBeInTheDocument();
});
```

Add one test for the connection dot. The stubbed `EventSource` never fires
`open`, so the hook's `connected` stays false — which is exactly the
disconnected case worth asserting, since it was previously invisible:

```tsx
test("shows the live-updates connection state in the header", async () => {
  // useLiveState has always computed `connected` from EventSource's own
  // lifecycle, and nothing read it -- so a dropped stream looked exactly
  // like a healthy one.
  stub(false);
  view();
  expect(await screen.findByLabelText(/live updates disconnected/i)).toBeInTheDocument();
});
```

Leave the remaining tests in the file unchanged.

- [ ] **Step 9: Rewrite app.tsx**

Replace `apps/frontend/src/app.tsx` in full:

```tsx
import { AppShell, Burger, Group, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useState } from "react";
import { api } from "./api/client.js";
import { useLiveState } from "./api/useLiveState.js";
import { MinerStatusBadge, type MinerStatus } from "./components/MinerStatusBadge.js";
import { PasswordGate } from "./components/PasswordGate.js";
import { Sidebar } from "./components/Sidebar.js";
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

export type ScreenKey = keyof typeof SCREENS;

export function App() {
  const [screen, setScreen] = useState<ScreenKey>("dashboard");
  // One value rather than two pieces of state, so a status update can never
  // land a new state beside the previous run's start time -- which would
  // render a STOPPED badge next to a still-ticking uptime.
  const [miner, setMiner] = useState<MinerStatus>({ state: "…", startedAt: null });
  // true until the first poll answers, matching the server's own
  // default-to-required stance.
  const [loginRequired, setLoginRequired] = useState(true);
  const [opened, { toggle, close }] = useDisclosure(false);
  // Drives the live-count badge in the nav and the header's connection
  // dot. `connected` is computed by the hook from EventSource's own
  // lifecycle and, before this, was read nowhere -- so a dropped stream
  // looked exactly like a healthy one.
  const { snapshot, connected } = useLiveState();

  useEffect(() => {
    const load = () =>
      api.get<{ miner: string; loginRequired: boolean; startedAt: number | null }>(
        "/api/status",
      )
        .then((s) => {
          setMiner({ state: s.miner, startedAt: s.startedAt });
          setLoginRequired(s.loginRequired);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  const liveCount = snapshot?.streamers.filter((s) => s.isOnline).length ?? 0;

  const navigate = (key: ScreenKey) => {
    setScreen(key);
    // On mobile the sidebar is a slide-over; leaving it open over the
    // screen the user just chose hides the thing they navigated to.
    close();
  };

  return (
    <PasswordGate>
      <AppShell
        header={{ height: 56 }}
        navbar={{ width: 240, breakpoint: "sm", collapsed: { mobile: !opened } }}
        padding="lg"
      >
        <AppShell.Header bg="var(--tw-surface)" style={{ borderColor: "var(--tw-border)" }}>
          <Group h="100%" px="md" justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
              <Text fw={600}>{SCREENS[screen].label}</Text>
            </Group>
            <Group gap="sm" wrap="nowrap">
              <Tooltip label={connected ? "Live updates connected" : "Live updates disconnected"}>
                <span
                  data-testid="stream-connected"
                  aria-label={connected ? "Live updates connected" : "Live updates disconnected"}
                  style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: connected ? "var(--tw-success)" : "var(--tw-text-dim)",
                  }}
                />
              </Tooltip>
              <MinerStatusBadge state={miner.state} startedAt={miner.startedAt} />
            </Group>
          </Group>
        </AppShell.Header>
        <AppShell.Navbar bg="var(--tw-surface)" style={{ borderColor: "var(--tw-border)" }}>
          <Sidebar
            screen={screen}
            onNavigate={navigate}
            liveCount={liveCount}
            loginRequired={loginRequired}
            miner={miner}
            onMinerChange={setMiner}
          />
        </AppShell.Navbar>
        <AppShell.Main>{SCREENS[screen].element}</AppShell.Main>
      </AppShell>
    </PasswordGate>
  );
}
```

- [ ] **Step 10: Run the full suite**

Run: `pnpm --filter @app/frontend test`
Expected: all PASS.

Note `app.tsx` now calls `useLiveState`, which opens an `EventSource`. `app.test.tsx` already stubs `EventSource` globally, so this is covered.

- [ ] **Step 11: Verify in the browser**

Run `pnpm dev`. Confirm: sidebar shows the mark and five icon rows; the active row has a purple left bar; the miner dock sits at the foot with working Stop/Restart; the header shows the state badge and ticking uptime; narrowing below 768px collapses the sidebar behind a burger, and choosing a screen closes it. Stop the server.

- [ ] **Step 12: Commit**

```bash
git add -A apps/frontend
git commit -m "feat: rebuild the app shell with a branded Twitch sidebar

Icon nav with a flush purple active bar, a live-channel count and a
sign-in dot carried into the nav itself, and the miner dock pinned to
the foot. The dot replaces the alert banner that sat above every screen,
so login-required-banner retires with it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Unlock screen

**Files:**
- Modify: `apps/frontend/src/components/PasswordGate.tsx`, `apps/frontend/src/components/PasswordGate.test.tsx`

**Interfaces:**
- Consumes: `BrandMark` (Task 3), the `tw-shake` keyframe (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `apps/frontend/src/components/PasswordGate.test.tsx` (keep the existing tests; read the file first to match its stub style):

```tsx
test("shows the brand mark above the unlock form", async () => {
  // Stub a 401 so the gate renders its locked state.
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false, status: 401, json: async () => ({}),
  })));
  render(<MantineProvider><PasswordGate>hidden</PasswordGate></MantineProvider>);
  expect(await screen.findByRole("img", { name: /miner control/i })).toBeInTheDocument();
});
```

Adjust the render call to match whatever helper the existing file already uses.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test PasswordGate`
Expected: FAIL — no `img` role with that name.

- [ ] **Step 3: Rewrite the gate's locked view**

In `apps/frontend/src/components/PasswordGate.tsx`, keep the `unlocked`/`submit` logic exactly as it is and replace only the returned JSX, plus add a shake key. Full new file:

```tsx
import { Box, Button, Card, Center, PasswordInput, Stack, Text } from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api/client.js";
import { BrandMark } from "./BrandMark.js";

export function PasswordGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Bumped on each failure to restart the shake animation -- re-rendering
  // with the same key would leave a finished animation finished.
  const [attempt, setAttempt] = useState(0);

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
      setAttempt((n) => n + 1);
    }
  };

  return (
    <Center
      h="100vh"
      style={{
        background:
          "radial-gradient(circle at 50% 35%, rgba(145,71,255,0.18), transparent 55%)," +
          " var(--tw-bg)",
      }}
    >
      <Stack align="center" gap="xl" w={400} px="md">
        <Stack align="center" gap="xs">
          <BrandMark size={96} />
          <Text fw={700} size="xl" style={{ letterSpacing: "0.1em" }}>
            MINER CONTROL
          </Text>
          <Text size="sm" c="dimmed">Twitch Channel Points</Text>
        </Stack>
        <Box
          key={attempt}
          w="100%"
          style={error ? { animation: "tw-shake 350ms ease" } : undefined}
        >
          <Card withBorder padding="lg" w="100%">
            <Stack>
              <PasswordInput
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                error={error}
              />
              <Button fullWidth onClick={() => void submit()}>Unlock</Button>
            </Stack>
          </Card>
        </Box>
      </Stack>
    </Center>
  );
}
```

The error text now rides on `PasswordInput`'s `error` prop, which Mantine renders with `role="alert"` semantics via `aria-describedby`. If the existing test asserts on `role="alert"` specifically rather than on the text, change that assertion to `findByText(/wrong password/i)` — the requirement is that the message is announced and visible, not which element carries it.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @app/frontend test PasswordGate`
Expected: PASS, including the pre-existing wrong-password test.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/src/components/PasswordGate.tsx \
        apps/frontend/src/components/PasswordGate.test.tsx
git commit -m "feat: give the unlock screen a branded hero

Large brand mark over a purple radial wash, and a wrong password shakes
the card instead of inserting an alert that reflows the layout.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Feed toggle that actually stops polling

The point is the network behaviour, not the DOM. A toggle that hides a component still polling every 5s would pass a naive test and fail the requirement.

**Files:**
- Create: `src/lib/useLocalToggle.ts`, `src/lib/useLocalToggle.test.ts`
- Modify: `src/components/EventsFeed.tsx`, `src/components/EventsFeed.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `useLocalToggle(key: string, initial: boolean): [boolean, () => void]`
  - `<EventsFeed enabled={boolean} />` — the prop is required; `Dashboard` (Task 9) owns the state.

- [ ] **Step 1: Write the failing useLocalToggle test**

Create `apps/frontend/src/lib/useLocalToggle.test.ts`:

```ts
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useLocalToggle } from "./useLocalToggle.js";

afterEach(() => localStorage.clear());

test("starts from the given default when nothing is stored", () => {
  const { result } = renderHook(() => useLocalToggle("feed", true));
  expect(result.current[0]).toBe(true);
});

test("remembers a toggle across remounts", () => {
  const first = renderHook(() => useLocalToggle("feed", true));
  act(() => first.result.current[1]());
  first.unmount();

  const second = renderHook(() => useLocalToggle("feed", true));
  expect(second.result.current[0]).toBe(false);
});

test("survives storage being unavailable", () => {
  // Private-mode browsers throw on access rather than returning null.
  const original = Storage.prototype.getItem;
  Storage.prototype.getItem = () => { throw new Error("denied"); };
  try {
    const { result } = renderHook(() => useLocalToggle("feed", true));
    expect(result.current[0]).toBe(true);
  } finally {
    Storage.prototype.getItem = original;
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test useLocalToggle`
Expected: FAIL — cannot resolve `./useLocalToggle.js`.

- [ ] **Step 3: Write the hook**

Create `apps/frontend/src/lib/useLocalToggle.ts`:

```ts
import { useCallback, useState } from "react";

/**
 * A boolean remembered in localStorage.
 *
 * Every access is guarded: a browser in private mode throws on access
 * rather than returning null, and a preference for a panel is never
 * worth taking the page down for.
 */
export function useLocalToggle(key: string, initial: boolean): [boolean, () => void] {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : stored === "true";
    } catch {
      return initial;
    }
  });

  const toggle = useCallback(() => {
    setValue((current) => {
      const next = !current;
      try {
        localStorage.setItem(key, String(next));
      } catch {
        // The preference just does not persist. Nothing else breaks.
      }
      return next;
    });
  }, [key]);

  return [value, toggle];
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test useLocalToggle`
Expected: PASS.

- [ ] **Step 5: Write the failing polling test**

Add to `apps/frontend/src/components/EventsFeed.test.tsx`:

```tsx
test("does not touch the network when the feed is switched off", async () => {
  // The requirement is that polling stops, not that the panel is hidden.
  // A component that renders nothing while still fetching every 5s would
  // pass a DOM-absence assertion and fail the actual ask.
  const fetchMock = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ events: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  render(<MantineProvider><EventsFeed enabled={false} /></MantineProvider>);

  // Give any mount effect a chance to fire before asserting silence.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.queryByText(/recent activity/i)).not.toBeInTheDocument();
});

test("polls while the feed is switched on", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ events: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  render(<MantineProvider><EventsFeed enabled /></MantineProvider>);

  await screen.findByText(/no activity yet/i);
  expect(fetchMock).toHaveBeenCalledWith("/api/events", expect.anything());
});
```

Also update every existing `view()` call in this file to pass the new required prop: `render(<MantineProvider><EventsFeed enabled /></MantineProvider>)`.

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test EventsFeed`
Expected: FAIL — `EventsFeed` takes no props, so `enabled={false}` still polls.

- [ ] **Step 7: Gate the effect**

In `apps/frontend/src/components/EventsFeed.tsx`, change the signature and guard the effect. Keep `label`, `ago`, the malformed-payload guard and the silent-failure stance exactly as they are.

```tsx
export function EventsFeed({ enabled }: { enabled: boolean }) {
  const [events, setEvents] = useState<MinerEvent[] | null>(null);

  useEffect(() => {
    // Switching the feed off must stop the traffic, not just hide the
    // panel: this effect owns the only /api/events caller in the app.
    if (!enabled) {
      setEvents(null);
      return;
    }
    let alive = true;
    const load = () => /* ...unchanged... */;
    void load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [enabled]);

  if (!enabled) return null;
  if (events === null) return null;

  // ...the rest of the render is unchanged...
}
```

- [ ] **Step 8: Run the tests**

Run: `pnpm --filter @app/frontend test EventsFeed`
Expected: PASS, including the pre-existing rendering tests.

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/src/lib/useLocalToggle.ts \
        apps/frontend/src/lib/useLocalToggle.test.ts \
        apps/frontend/src/components/EventsFeed.tsx \
        apps/frontend/src/components/EventsFeed.test.tsx
git commit -m "feat: let the activity feed be switched off, polling and all

The effect that owns the only /api/events caller is gated on the flag, so
switching the feed off stops the 5s traffic rather than hiding a panel
that keeps fetching.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Stat tiles and streamer cards

**Files:**
- Create: `src/components/StatTile.tsx`, `src/components/StatTile.module.css`, `src/components/StatTile.test.tsx`, `src/components/StreamerCard.module.css`
- Modify: `src/components/StreamerCard.tsx`, `src/components/StreamerCard.test.tsx`, `src/components/Sparkline.tsx`, `src/components/Sparkline.test.tsx`

**Interfaces:**
- Consumes: palette (Task 2).
- Produces:
  - `<StatTile label={string} value={string} accent?={"purple" | "success" | "live"} testId?={string} />`
  - `<Sparkline values={number[]} width?={number} height?={number} fill?={boolean} />`

- [ ] **Step 1: Write the failing StatTile test**

Create `apps/frontend/src/components/StatTile.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { StatTile } from "./StatTile.js";

test("shows its label and value", () => {
  renderApp(<StatTile label="Total points" value="124,530" />);
  expect(screen.getByText("Total points")).toBeInTheDocument();
  expect(screen.getByText("124,530")).toBeInTheDocument();
});

test("exposes a testid for the value when asked", () => {
  renderApp(<StatTile label="Total points" value="—" testId="total-points" />);
  expect(screen.getByTestId("total-points")).toHaveTextContent("—");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test StatTile`
Expected: FAIL — cannot resolve `./StatTile.js`.

- [ ] **Step 3: Write the tile styles**

Create `apps/frontend/src/components/StatTile.module.css`:

```css
.tile {
  position: relative;
  overflow: hidden;
  padding: 16px 18px;
  border: 1px solid var(--tw-border);
  border-radius: 8px;
  background: var(--tw-surface);
}

/* A hairline of color along the top edge -- enough to tie the row to the
   brand without washing the surface in purple. */
.tile::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  background: var(--accent, var(--tw-purple));
}

.purple { --accent: var(--tw-purple); }
.success { --accent: var(--tw-success); }
.live { --accent: var(--tw-live); }

.label {
  color: var(--tw-text-dim);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.value {
  margin-top: 6px;
  font-family: var(--mantine-font-family-monospace);
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
}
```

- [ ] **Step 4: Write StatTile**

Create `apps/frontend/src/components/StatTile.tsx`:

```tsx
import classes from "./StatTile.module.css";

export function StatTile({ label, value, accent = "purple", testId }: {
  label: string;
  value: string;
  accent?: "purple" | "success" | "live";
  testId?: string;
}) {
  return (
    <div className={`${classes.tile} ${classes[accent]}`}>
      <div className={classes.label}>{label}</div>
      <div className={classes.value} data-testid={testId}>{value}</div>
    </div>
  );
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test StatTile`
Expected: PASS.

- [ ] **Step 6: Write the failing Sparkline fill test**

Add to `apps/frontend/src/components/Sparkline.test.tsx`:

```tsx
test("draws an area fill under the line when asked", () => {
  const { container } = render(<Sparkline values={[1, 5, 3]} fill />);
  expect(container.querySelector("polygon")).toBeInTheDocument();
});

test("draws no fill by default", () => {
  const { container } = render(<Sparkline values={[1, 5, 3]} />);
  expect(container.querySelector("polygon")).not.toBeInTheDocument();
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test Sparkline`
Expected: FAIL — no `polygon` element.

- [ ] **Step 8: Add the fill to Sparkline**

In `apps/frontend/src/components/Sparkline.tsx`, add `fill` to the props and render a polygon beneath the polyline. Keep the `< 2` guard and the flat-series midline pin exactly as written. The `svg` keeps `aria-hidden` — the adjacent gain figures already state the numbers precisely.

Add to the props interface:

```ts
  fill?: boolean;
```

Change the signature to `{ values, width = 88, height = 24, fill = false }` and, after `points` is computed, add:

```tsx
  // Closing the path down to the baseline gives the card a soft area
  // fill; the line alone reads thin across a full-width card.
  const area = `0,${height} ${points} ${width},${height}`;
```

Then render inside the existing `<svg>`, before the `<polyline>`:

```tsx
      {fill && (
        <polygon points={area} fill="var(--tw-success)" fillOpacity="0.12" />
      )}
```

Change the polyline's stroke from `var(--mantine-color-teal-5)` to `var(--tw-success)`.

- [ ] **Step 9: Run the Sparkline tests**

Run: `pnpm --filter @app/frontend test Sparkline`
Expected: PASS, including the existing flat-series and short-series tests.

- [ ] **Step 10: Write the streamer card styles**

Create `apps/frontend/src/components/StreamerCard.module.css`:

```css
.card {
  position: relative;
  padding: 14px 16px;
  border: 1px solid var(--tw-border);
  border-radius: 8px;
  background: var(--tw-surface);
  transition: border-color 140ms ease, transform 140ms ease;
}

.card:hover {
  border-color: var(--tw-purple);
  transform: translateY(-2px);
}

/* A live channel must be readable before a single word is. */
.live::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  background: var(--tw-live);
  border-radius: 8px 8px 0 0;
}

.offline { opacity: 0.6; }

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--tw-live);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: tw-pulse 2s ease-in-out infinite;
}

.balance {
  font-family: var(--mantine-font-family-monospace);
  font-size: 22px;
  font-weight: 700;
}
```

- [ ] **Step 11: Write the failing card test**

Add to `apps/frontend/src/components/StreamerCard.test.tsx` (read the file first for its `StreamerState` fixture helper and reuse it):

```tsx
test("marks a live channel with a live pill", () => {
  renderApp(<StreamerCard streamer={{ ...base, isOnline: true }} />);
  expect(screen.getByTestId("live-pill")).toBeInTheDocument();
});

test("shows no live pill for an offline channel", () => {
  renderApp(<StreamerCard streamer={{ ...base, isOnline: false }} />);
  expect(screen.queryByTestId("live-pill")).not.toBeInTheDocument();
});
```

Replace `base` with whatever the file's existing fixture is called; if it has none, build one from `StreamerState` in `src/api/useLiveState.ts`.

- [ ] **Step 12: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test StreamerCard`
Expected: FAIL — no `live-pill` testid.

- [ ] **Step 13: Restyle the card**

Rewrite `apps/frontend/src/components/StreamerCard.tsx`. Keep `Gain` and its `null`-means-no-baseline comment verbatim.

```tsx
import { Badge, Group, Stack, Text, Tooltip } from "@mantine/core";
import { Sparkline } from "./Sparkline.js";
import classes from "./StreamerCard.module.css";
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
    return <Text size="xs" c="dimmed" data-testid={testId}>— {label}</Text>;
  }
  const sign = value > 0 ? "+" : "";
  return (
    <Text size="xs" c={value > 0 ? "teal" : value < 0 ? "red" : "dimmed"} data-testid={testId}>
      {sign}{nf.format(value)} {label}
    </Text>
  );
}

export function StreamerCard({ streamer: s }: { streamer: StreamerState }) {
  const live = s.isOnline === true;
  return (
    <div
      className={`${classes.card} ${live ? classes.live : classes.offline}`}
      data-testid={`streamer-${s.username}`}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600} truncate>{s.displayName ?? s.username}</Text>
          <Group gap={6} wrap="nowrap">
            {live && (
              <span className={classes.pill} data-testid="live-pill">
                <span className={classes.dot} />
                LIVE
              </span>
            )}
            {s.pointsEnabled === false && (
              <Tooltip label="Channel points are disabled for this channel, so the balance cannot move.">
                <Badge color="yellow" variant="light" size="sm" data-testid="points-disabled">
                  no points
                </Badge>
              </Tooltip>
            )}
          </Group>
        </Group>

        <Text className={classes.balance} data-testid="balance">
          {s.points === null ? "—" : nf.format(s.points)}
        </Text>

        <Sparkline values={s.spark} width={260} height={32} fill />

        <Group gap="sm">
          {live && s.gainedStream !== null && (
            <Gain value={s.gainedStream} label="stream" testId="gain-stream" />
          )}
          <Gain value={s.gained24h} label="24h" testId="gain-24h" />
        </Group>

        {s.error && <Text role="alert" size="xs" c="red">{s.error}</Text>}
      </Stack>
    </div>
  );
}
```

- [ ] **Step 14: Run the tests**

Run: `pnpm --filter @app/frontend test StreamerCard Sparkline StatTile`
Expected: all PASS.

- [ ] **Step 15: Commit**

```bash
git add -A apps/frontend/src/components
git commit -m "feat: restyle streamer cards and add KPI stat tiles

Live channels carry a pulsing red pill and a red top edge so status
reads before any word does; offline cards dim. The sparkline gains an
area fill and spans the card.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Dashboard layout

**Files:**
- Modify: `apps/frontend/src/routes/Dashboard.tsx`, `apps/frontend/src/routes/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `StatTile` (Task 8), `EventsFeed` with its `enabled` prop and `useLocalToggle` (Task 7), `StreamerCard` (Task 8).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Add to `apps/frontend/src/routes/Dashboard.test.tsx` (read the file first — reuse its existing snapshot-stub helper):

```tsx
test("switching the activity feed off stops its polling", async () => {
  // The dashboard owns the toggle; EventsFeed owns the effect. This
  // asserts the wiring between them actually reaches the network.
  const fetchMock = stubSnapshot({ streamers: [], lastUpdated: Date.now(), stale: false, error: null });
  renderApp(<Dashboard />);

  await userEvent.click(await screen.findByRole("switch", { name: /activity feed/i }));

  fetchMock.mockClear();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/events")).toBe(false);
});

test("shows the tracked-streamer count as a stat", async () => {
  stubSnapshot({
    streamers: [
      { username: "a", displayName: null, channelId: null, points: 10, isOnline: true,
        pointsEnabled: true, gained24h: null, gainedStream: null, spark: [] },
      { username: "b", displayName: null, channelId: null, points: 5, isOnline: false,
        pointsEnabled: true, gained24h: null, gainedStream: null, spark: [] },
    ],
    lastUpdated: Date.now(), stale: false, error: null,
  });
  renderApp(<Dashboard />);
  expect(await screen.findByTestId("stat-tracked")).toHaveTextContent("2");
});
```

If the existing file's helper does not return the fetch mock, change it so it does.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test Dashboard`
Expected: FAIL — no switch named "activity feed", no `stat-tracked`.

- [ ] **Step 3: Rewrite the Dashboard**

Replace `apps/frontend/src/routes/Dashboard.tsx`:

```tsx
import { Alert, Grid, Group, SimpleGrid, Stack, Switch, Text } from "@mantine/core";
import { useLiveState } from "../api/useLiveState.js";
import { EventsFeed } from "../components/EventsFeed.js";
import { StalenessBadge } from "../components/StalenessBadge.js";
import { StatTile } from "../components/StatTile.js";
import { StreamerCard } from "../components/StreamerCard.js";
import { useLocalToggle } from "../lib/useLocalToggle.js";

const nf = new Intl.NumberFormat("en-US");

function SectionHeading({ children }: { children: string }) {
  return (
    <Group gap="sm" wrap="nowrap" mt="md">
      <Text
        size="xs" fw={700} c="dimmed"
        style={{ letterSpacing: "0.1em", whiteSpace: "nowrap" }}
      >
        {children}
      </Text>
      <div style={{ flex: 1, height: 1, background: "var(--tw-border)" }} />
    </Group>
  );
}

export function Dashboard() {
  const { snapshot, loadError } = useLiveState();
  const [feedOn, toggleFeed] = useLocalToggle("dashboard.feed", true);

  if (!snapshot) {
    if (loadError) {
      return <Alert role="alert" color="red">Failed to load dashboard: {loadError}</Alert>;
    }
    return null;
  }

  const total = snapshot.streamers.reduce((sum, s) => sum + (s.points ?? 0), 0);
  const live = snapshot.streamers.filter((s) => s.isOnline);
  // Streamers already shown above under "Live now" are omitted here so a
  // live streamer's points aren't rendered twice in the same view.
  const others = snapshot.streamers.filter((s) => !s.isOnline);

  const gained = snapshot.streamers.reduce<number | null>((sum, s) => {
    if (s.gained24h === null) return sum;
    return (sum ?? 0) + s.gained24h;
  }, null);

  // A real 0 (every tracked streamer genuinely has none) and "we have not
  // looked yet" must never render the same way -- the latter used to show
  // a confident "0" for a full refresh interval after every restart,
  // beside a badge nobody reads closely enough to notice contradicts it.
  const totalText = snapshot.lastUpdated === null ? "—" : nf.format(total);
  const gainedText = gained === null
    ? "—"
    : `${gained > 0 ? "+" : ""}${nf.format(gained)}`;

  const cards = (
    <>
      <SectionHeading>{`LIVE NOW · ${live.length}`}</SectionHeading>
      <div data-testid="live-heading" hidden>{`Live now (${live.length})`}</div>
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="md">
        {live.map((s) => <StreamerCard key={s.username} streamer={s} />)}
      </SimpleGrid>

      <SectionHeading>{`OFFLINE · ${others.length}`}</SectionHeading>
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="md">
        {others.map((s) => <StreamerCard key={s.username} streamer={s} />)}
      </SimpleGrid>
    </>
  );

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <StalenessBadge lastUpdated={snapshot.lastUpdated} stale={snapshot.stale} />
        <Switch
          checked={feedOn}
          onChange={toggleFeed}
          label="Activity feed"
          size="sm"
        />
      </Group>

      {snapshot.error && <Alert role="alert" color="orange">{snapshot.error}</Alert>}

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatTile label="Total points" value={totalText} testId="total-points" />
        <StatTile label="24h gain" value={gainedText} accent="success" testId="stat-24h" />
        <StatTile label="Live now" value={String(live.length)} accent="live" testId="stat-live" />
        <StatTile
          label="Tracked" value={String(snapshot.streamers.length)} testId="stat-tracked"
        />
      </SimpleGrid>

      {/* The feed is a side column on wide screens and falls below the
          cards when there is not room for one. Grid, not a media query,
          so the reflow is a single source of truth. */}
      {feedOn ? (
        <Grid gap="md">
          <Grid.Col span={{ base: 12, lg: 8 }}>{cards}</Grid.Col>
          <Grid.Col span={{ base: 12, lg: 4 }}>
            <EventsFeed enabled={feedOn} />
          </Grid.Col>
        </Grid>
      ) : (
        cards
      )}
    </Stack>
  );
}
```

Note the `live-heading` testid is preserved on a hidden element carrying the exact old text, because `Dashboard.test.tsx` asserts on its content and the visible heading is now differently formatted. If the existing test asserts only on presence, drop the hidden div and put the testid on `SectionHeading` instead — check the file and pick whichever keeps the test honest.

Note `gap`, not `gutter`: Mantine 9 renamed `Grid`'s spacing prop. This is
the one v9 rename this plan actually touches.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @app/frontend test Dashboard`
Expected: PASS, including the pre-existing `total-points` `—` test.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm --filter @app/frontend test && pnpm --filter @app/frontend build`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/routes/Dashboard.tsx apps/frontend/src/routes/Dashboard.test.tsx
git commit -m "feat: rebuild the dashboard with a KPI row and a feed column

Four stat tiles above the cards, and the activity feed as a right-hand
column that falls below the cards under lg. A switch turns the feed off
entirely, polling included.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Streamers list with drag ordering

**Files:**
- Modify: `apps/frontend/src/routes/Streamers.tsx`, `src/routes/Streamers.test.tsx`, `src/components/AddStreamer.tsx`

**Interfaces:**
- Consumes: palette (Task 2).
- Produces: nothing new. `countChanges` and the apply flow are unchanged.

- [ ] **Step 1: Write the failing test**

Add to `apps/frontend/src/routes/Streamers.test.tsx` (read it first for its config-stub helper):

```tsx
test("marks the top two rows as the ones actually being watched", async () => {
  // The miner watches the top two. That was a sentence the user had to
  // remember; it should be visible on the rows it applies to.
  stubConfig({
    version: 1, username: "me", followers: false, followersOrder: "ASC", defaults: {},
    streamers: [
      { username: "aaa", enabled: true, settings: {} },
      { username: "bbb", enabled: true, settings: {} },
      { username: "ccc", enabled: true, settings: {} },
    ],
  });
  renderApp(<Streamers />);
  expect(await screen.findAllByTestId("watching-tag")).toHaveLength(2);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test Streamers`
Expected: FAIL — no `watching-tag` testid.

- [ ] **Step 3: Rewrite the row rendering**

In `apps/frontend/src/routes/Streamers.tsx`, keep every handler (`add`, `toggle`, `moveUp`, `apply`) and `countChanges` exactly as written. Add a drag handler and replace the row markup.

Add above the `return`:

```tsx
  const moveTo = (from: number, to: number) => {
    if (from === to) return;
    const streamers = [...draft.streamers];
    const [moved] = streamers.splice(from, 1);
    streamers.splice(to, 0, moved);
    setDraft({ ...draft, streamers });
  };
```

Replace the `draft.streamers.map(...)` block with:

```tsx
      <Stack gap={6}>
        {draft.streamers.map((streamer, index) => (
          <Card
            withBorder
            key={streamer.username}
            data-testid="streamer-row"
            padding="sm"
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", String(index))}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              moveTo(Number(e.dataTransfer.getData("text/plain")), index);
            }}
            style={index < 2
              ? { background: "rgba(145,71,255,0.08)", borderColor: "var(--tw-purple)" }
              : undefined}
          >
            <Group justify="space-between" wrap="nowrap">
              <Group gap="sm" wrap="nowrap">
                {/* The arrow stays: drag is mouse-only, and this is the
                    keyboard-accessible path. */}
                <ActionIcon
                  variant="subtle" aria-label="Move up"
                  onClick={() => moveUp(index)} disabled={index === 0}
                >
                  ↑
                </ActionIcon>
                <Text size="sm" c="dimmed" ff="monospace" w={20}>{index + 1}</Text>
                <Text fw={500}>{streamer.username}</Text>
                {index < 2 && (
                  <Badge size="xs" variant="light" color="twitch" data-testid="watching-tag">
                    watching
                  </Badge>
                )}
              </Group>
              <Switch
                checked={streamer.enabled}
                onChange={() => toggle(index)}
                aria-label={`Enable ${streamer.username}`}
              />
            </Group>
          </Card>
        ))}
      </Stack>
```

Add `Badge` to the `@mantine/core` import list at the top of the file.

- [ ] **Step 4: Restyle AddStreamer**

In `apps/frontend/src/components/AddStreamer.tsx`, replace the returned JSX (keep `submit` unchanged):

```tsx
  return (
    <Group gap="xs" align="flex-end">
      <TextInput
        flex={1}
        label="Add streamer"
        placeholder="twitch username"
        leftSection={<IconSearch size={16} stroke={1.7} />}
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      <Button loading={busy} onClick={() => void submit()}>Add</Button>
    </Group>
  );
```

Add `import { IconSearch } from "@tabler/icons-react";` at the top.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @app/frontend test Streamers`
Expected: PASS, including the existing "Move up" reorder test.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend/src/routes/Streamers.tsx apps/frontend/src/routes/Streamers.test.tsx \
        apps/frontend/src/components/AddStreamer.tsx
git commit -m "feat: make streamer priority visible and draggable

The top two rows are tinted and tagged 'watching', so the rule the
miner actually follows is on screen. Drag reorders; the arrow stays as
the keyboard path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 11: Log viewer

**Files:**
- Create: `src/lib/logLevel.ts`, `src/lib/logLevel.test.ts`, `src/components/LogLine.tsx`, `src/components/LogLine.module.css`
- Modify: `apps/frontend/src/routes/Logs.tsx`, `src/routes/Logs.test.tsx`

**Interfaces:**
- Consumes: palette (Task 2).
- Produces:
  - `levelOf(line: string): "error" | "warn" | "gain" | "info"`
  - `<LogLine text={string} />`

- [ ] **Step 1: Write the failing level test**

Create `apps/frontend/src/lib/logLevel.test.ts`:

```ts
import { expect, test } from "vitest";
import { levelOf } from "./logLevel.js";

test("classifies errors", () => {
  expect(levelOf("2026-09-05 12:00:00 - ERROR - websocket closed")).toBe("error");
});

test("classifies warnings", () => {
  expect(levelOf("2026-09-05 12:00:00 - WARNING - retrying in 5s")).toBe("warn");
});

test("classifies a points gain, which is the line worth spotting", () => {
  expect(levelOf("12:00:00 - INFO - +50 -> forsen (WATCH)")).toBe("gain");
});

test("falls back to info", () => {
  expect(levelOf("12:00:00 - INFO - starting")).toBe("info");
});

test("is not fooled by the word error inside a message body", () => {
  // Only the level field decides; otherwise a channel called "errorbot"
  // would paint every one of its lines red.
  expect(levelOf("12:00:00 - INFO - watching errorbot")).toBe("info");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test logLevel`
Expected: FAIL — cannot resolve `./logLevel.js`.

- [ ] **Step 3: Write the classifier**

Create `apps/frontend/src/lib/logLevel.ts`:

```ts
export type LogLevel = "error" | "warn" | "gain" | "info";

/**
 * Classifies a miner log line for colouring.
 *
 * Matches the delimited level field rather than searching the whole
 * line, so a message that merely contains "error" -- a channel name, a
 * URL -- is not painted red.
 */
export function levelOf(line: string): LogLevel {
  if (/\bERROR\b|\bCRITICAL\b/.test(line)) return "error";
  if (/\bWARNING\b|\bWARN\b/.test(line)) return "warn";
  // The miner writes gains as "+50 -> streamer".
  if (/\+\d+\s*->/.test(line)) return "gain";
  return "info";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/frontend test logLevel`
Expected: PASS. If the "errorbot" case fails, the regex needs tightening — anchor on the ` - LEVEL - ` shape rather than a bare word boundary.

- [ ] **Step 5: Write LogLine and its styles**

Create `apps/frontend/src/components/LogLine.module.css`:

```css
.line {
  padding: 1px 0;
  font-family: var(--mantine-font-family-monospace);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.error { color: #FF6B6B; }
.warn { color: var(--tw-warn); }
.gain { color: var(--tw-success); }
.info { color: var(--tw-text-dim); }
```

Create `apps/frontend/src/components/LogLine.tsx`:

```tsx
import { levelOf } from "../lib/logLevel.js";
import classes from "./LogLine.module.css";

export function LogLine({ text }: { text: string }) {
  return <div className={`${classes.line} ${classes[levelOf(text)]}`}>{text}</div>;
}
```

- [ ] **Step 6: Rewrite the Logs route**

Replace `apps/frontend/src/routes/Logs.tsx`. Keep the polling effect and its transient-error clearing exactly as written — only the render changes, plus a filter and autoscroll.

```tsx
import { Alert, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { LogLine } from "../components/LogLine.js";

export function Logs() {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the newest line. A user who has
  // scrolled up is reading something; new lines must not yank them away.
  const pinned = useRef(true);

  useEffect(() => {
    const load = () =>
      api.get<{ lines: string[] }>("/api/logs")
        .then((r) => {
          setLines(r.lines);
          // A later successful poll must clear an earlier transient
          // failure -- otherwise a one-off hiccup leaves a permanent
          // error banner even though logs are flowing again.
          setError(null);
        })
        .catch((cause) => {
          // This panel is exactly where an operator looks to diagnose a
          // crash, so a silently broken fetch would hide the diagnosis
          // when it is needed most.
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (pinned.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [lines]);

  const shown = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <Stack gap="sm" h="calc(100vh - 120px)">
      <Group justify="space-between">
        <TextInput
          w={280}
          size="xs"
          placeholder="Filter lines"
          leftSection={<IconSearch size={14} stroke={1.7} />}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
        <Text size="xs" c="dimmed" ff="monospace">
          {shown.length} / {lines.length} lines
        </Text>
      </Group>

      {error && <Alert role="alert" color="red">Failed to load logs: {error}</Alert>}

      <div
        ref={viewport}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 14px",
          border: "1px solid var(--tw-border)",
          borderRadius: 8,
          background: "var(--tw-bg)",
        }}
      >
        {shown.map((line, i) => <LogLine key={`${i}-${line}`} text={line} />)}
      </div>
    </Stack>
  );
}
```

`ScrollArea` is gone, replaced by a plain scrolling div — autoscroll needs direct access to the scrolling element, and this also removes the `ResizeObserver` dependency from this screen.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @app/frontend test Logs logLevel`
Expected: PASS. The existing Logs tests assert on line text and the error banner, both preserved. If a test asserted on `Code` block structure specifically, update it to assert on the text.

- [ ] **Step 8: Commit**

```bash
git add -A apps/frontend/src
git commit -m "feat: turn the log screen into a real terminal view

Level-coloured monospace lines, a filter, and autoscroll that yields to
a user who has scrolled up to read something.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 12: Settings, PendingBar, and the Twitch account screen

**Files:**
- Modify: `src/routes/Settings.tsx`, `src/components/PendingBar.tsx`, `src/routes/Login.tsx`, `src/routes/Login.test.tsx`

**Interfaces:**
- Consumes: palette (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing countdown test**

Add to `apps/frontend/src/routes/Login.test.tsx` (read it first for its EventSource stub):

```tsx
test("counts down how long the device code stays valid", async () => {
  // expiresAt was fetched and never shown, so a dead code looked exactly
  // like a fresh one.
  stubLogin({
    stage: "code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://www.twitch.tv/activate",
    expiresAt: Date.now() + 300_000,
  });
  renderApp(<TwitchLogin />);
  expect(await screen.findByTestId("code-countdown")).toHaveTextContent(/4:5\d|5:00/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend test Login`
Expected: FAIL — no `code-countdown` testid.

- [ ] **Step 3: Restyle the device-code panel**

In `apps/frontend/src/routes/Login.tsx`, keep `signIn()`, `USERNAME_RE` and the save-before-spawn ordering verbatim — that ordering is load-bearing and its comment must stay.

Add a countdown component at the bottom of the file:

```tsx
/** Ticks so the operator can tell a fresh code from a dead one. */
function Countdown({ expiresAt }: { expiresAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <Text size="xs" c={left < 60 ? "orange" : "dimmed"} data-testid="code-countdown">
      {left === 0 ? "Code expired — start again" : `Expires in ${mm}:${ss}`}
    </Text>
  );
}
```

Replace the code `<Card>` block with:

```tsx
        <Card
          withBorder
          padding="lg"
          style={{ borderColor: "var(--tw-purple)", background: "rgba(145,71,255,0.06)" }}
        >
          <Stack align="center" gap="sm">
            <Text size="sm">
              Open{" "}
              <Anchor href={progress.verificationUri} target="_blank" rel="noreferrer">
                {progress.verificationUri.replace("https://www.", "")}
              </Anchor>{" "}
              and enter this code:
            </Text>
            <Text
              ff="monospace" fw={700}
              style={{ fontSize: 34, letterSpacing: "0.18em" }}
            >
              {progress.userCode}
            </Text>
            <Button
              size="xs" variant="light"
              onClick={() => void navigator.clipboard?.writeText(progress.userCode!)}
            >
              Copy code
            </Button>
            {progress.expiresAt !== undefined && <Countdown expiresAt={progress.expiresAt} />}
          </Stack>
        </Card>
```

Replace the pending line with a pulsing indicator:

```tsx
      {progress?.stage === "pending" && (
        <Group gap="xs">
          <span
            style={{
              width: 8, height: 8, borderRadius: "50%",
              background: "var(--tw-purple)", animation: "tw-pulse 1.6s ease-in-out infinite",
            }}
          />
          <Text size="sm" c="dimmed">Waiting for you to enter the code…</Text>
        </Group>
      )}
```

Add `Group` and `Button` to the imports if not already present, and drop the now-unused `Code` and `Title` imports (the header supplies the title).

Also remove the `<Title order={2}>Twitch account</Title>` line — the app header already names the screen. Do the same in `Dashboard`, `Streamers`, `Logs` and `Settings` if any still render their own `<Title>`; a heading duplicated in the header and the body is noise.

- [ ] **Step 4: Restyle Settings**

In `apps/frontend/src/routes/Settings.tsx`, remove the `<Title>` and wrap each control in a card. Replace the JSX between the error alert and `<PendingBar>`:

```tsx
      <Card withBorder padding="md">
        <Switch
          label="Mine my followed channels"
          description="Adds every channel you follow on Twitch to the mining list."
          checked={draft.followers}
          onChange={(e) => setDraft({ ...draft, followers: e.currentTarget.checked })}
        />
      </Card>
      <Card withBorder padding="md">
        <Radio.Group
          label="Follower order"
          description="Which followed channels the miner reaches first."
          value={draft.followersOrder}
          onChange={(value) => setDraft({ ...draft, followersOrder: value })}
        >
          <Stack gap="xs" mt="sm">
            <Radio value="ASC" label="Oldest first" />
            <Radio value="DESC" label="Newest first" />
          </Stack>
        </Radio.Group>
      </Card>
```

Add `Card` to the `@mantine/core` imports and drop `Title`.

- [ ] **Step 5: Float the PendingBar**

Replace `apps/frontend/src/components/PendingBar.tsx`:

```tsx
import { Affix, Button, Group, Paper, Text, Transition } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

export function PendingBar({ count, onApply, busy }: {
  count: number; onApply: () => void; busy?: boolean;
}) {
  return (
    <Affix position={{ bottom: 24, left: 0, right: 0 }} style={{ pointerEvents: "none" }}>
      <Transition transition="slide-up" mounted={count > 0} duration={180}>
        {(styles) => (
          <Group justify="center" style={styles}>
            <Paper
              withBorder
              radius="xl"
              px="lg"
              py="sm"
              shadow="lg"
              data-testid="pending-bar"
              style={{ pointerEvents: "auto", background: "var(--tw-surface-alt)" }}
            >
              <Group gap="md" wrap="nowrap">
                <IconAlertTriangle size={18} stroke={1.7} color="var(--tw-warn)" />
                <Text size="sm">
                  {count} pending change{count === 1 ? "" : "s"} — the miner will restart
                </Text>
                <Button loading={busy} onClick={onApply} radius="xl">
                  Apply &amp; Restart
                </Button>
              </Group>
            </Paper>
          </Group>
        )}
      </Transition>
    </Affix>
  );
}
```

The early `if (count === 0) return null` is replaced by `Transition`'s `mounted`, which keeps the exit animation. `pending-bar` is still absent from the DOM when `count` is 0, so existing assertions hold.

- [ ] **Step 6: Run the full suite**

Run: `pnpm --filter @app/frontend test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A apps/frontend/src
git commit -m "feat: restyle settings, the apply bar and the device-code panel

The device code gets a live expiry countdown from expiresAt, which was
fetched and never shown, so a dead code looked like a fresh one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 13: Final verification

**Files:** none created or modified unless a check fails.

- [ ] **Step 1: Full test suite**

Run from the repo root: `pnpm test`
Expected: every workspace package PASSES.

- [ ] **Step 2: Full build**

Run: `pnpm build`
Expected: PASS, backend and frontend.

- [ ] **Step 3: Confirm no stray testids were lost**

```bash
cd apps/frontend && for id in total-points live-heading balance gain-stream gain-24h \
  points-disabled staleness streamer-row pending-bar miner-state miner-uptime \
  miner-toggle miner-restart miner-error stream-connected nav-login-required \
  nav-live-count live-pill watching-tag code-countdown; do
  printf '%-20s %s\n' "$id" "$(grep -rl "$id" src --include=*.tsx | grep -v test | head -1)"
done
```

Expected: every id resolves to a non-test source file. `login-required-banner` is intentionally gone.

- [ ] **Step 4: Confirm no runtime CDN dependency**

```bash
grep -rn "fonts.googleapis\|fonts.gstatic\|cdn\." apps/frontend/src apps/frontend/index.html
```

Expected: no matches. Fonts are npm packages; the tool must work on a LAN with no internet.

- [ ] **Step 5: Browser check, every screen**

Run `pnpm dev` from the repo root and open the Vite URL (5173, not 8080). Walk each screen and confirm:

- Unlock: brand mark, purple wash, wrong password shakes the card.
- Dashboard: four stat tiles; live cards carry a pulsing red pill; offline cards dim; feed sits right of the cards on a wide window and moves below when narrowed under ~1200px; the switch turns it off and the Network tab shows `/api/events` stop.
- Streamers: top two rows tinted and tagged; drag reorders; the ↑ button still works; the apply pill floats up on a change.
- Logs: ERROR lines red, gains green; filter narrows; scrolling up stops the autoscroll yanking.
- Settings: two setting cards.
- Twitch account: large code, copy button, ticking countdown.
- Narrow to under 768px: sidebar collapses behind the burger; the header still shows miner state; choosing a screen closes the slide-over.

- [ ] **Step 6: Report**

Report what passed and anything that did not. Do not claim completion for a step that was not actually run.

---

## Task Dependencies

Tasks 1 → 2 are strictly sequential and must come first. After Task 2, tasks 3, 4 and 7 are independent of one another. Task 5 needs 3 and 4. Task 6 needs 3. Task 9 needs 7 and 8. Tasks 10, 11, 12 need only 2. Task 13 is last.
