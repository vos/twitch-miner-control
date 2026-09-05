# Twitch-native UI overhaul

Status: approved for planning
Date: 2026-09-05

## Goal

Replace the stock-Mantine look with a deliberate Twitch.tv-native dark
interface, and restructure the screens so the miner's state is legible at a
glance. The app currently renders Mantine 8 defaults with no theme, no
brand, and no visual hierarchy: every surface is the same card, every
number the same weight.

## Decisions

Settled with the user before writing this spec:

- **Dark only.** Not OS-following. One palette, tuned properly.
- **Mantine 9 with a theme layer.** Not Tailwind, not hand-rolled CSS.
- **Custom SVG hero on the unlock screen.** Not the upstream banner.
- **Full restructure**, not a reskin: dashboard, streamers, logs and
  settings all change shape.
- **Miner actions in the sidebar, status in the header.**
- **Activity feed in a side column, collapsing below cards when narrow,
  and switchable off entirely — including its polling.**

### Why not the upstream banner

The user's request named `rdavydov/Twitch-Channel-Points-Miner-v2`'s
`assets/banner.png`. Two problems, both raised and accepted:

1. This repo vendors the **mpforce1** fork (see `.gitmodules`), not
   rdavydov's. The banner is branded "V2" for a different project.
2. The art is amber-on-hard-white. On a dark Twitch-purple screen it is a
   white rectangle unless heavily treated, which fights the whole theme.

We draw our own mark instead: inline SVG, ~2KB, sharp at any size,
inheriting theme colors, with no third-party art and no fork mismatch.

### Why Mantine 9 rather than staying on 8

Installed is 8.3.18; latest is 9.6.0. The migration surface for *this*
codebase was measured, not assumed — grepping for every breaking change in
the 8.x→9.x guide returns **zero hits**:

- No `<Text color=>` / `<Anchor color=>` (removed in 9; we use `c=`).
- No `Grid`, `Collapse`, `Spoiler`, `TypographyStylesProvider`,
  `positionDependencies`, `useForm`, `zodResolver`.
- No `@mantine/hooks` imports at all in source, so no split/renamed hooks.
- React is already 19.2.8, satisfying 9's React 19.2+ requirement.

Two v9 changes do reach us, and both are wanted here rather than
suppressed:

- Default radius moves `sm` (4px) → `md` (8px). Suits the softer Twitch
  card look; we set radius explicitly in the theme regardless.
- `light` variant colors become solid instead of transparent. Affects our
  `variant="light"` badges. We restyle those deliberately and do **not**
  adopt `v8CssVariablesResolver`, which would only preserve a default we
  are replacing anyway.

## Foundation

### Palette

Twitch's real values, as CSS custom properties in a theme stylesheet and
mirrored into the Mantine theme:

| Token | Value | Use |
|---|---|---|
| `--tw-bg` | `#0E0E10` | app background |
| `--tw-surface` | `#18181B` | cards, nav, header |
| `--tw-surface-alt` | `#1F1F23` | hover, inset panels |
| `--tw-border` | `#2F2F35` | hairlines |
| `--tw-purple` | `#9147FF` | primary, brand |
| `--tw-purple-hover` | `#772CE8` | hover/pressed |
| `--tw-live` | `#EB0400` | live dot and pill |
| `--tw-success` | `#00F593` | gains, RUNNING |
| `--tw-warn` | `#FFB300` | stale, sign-in needed |
| `--tw-text` | `#EFEFF1` | primary text |
| `--tw-text-dim` | `#ADADB8` | secondary text |

Purple is registered as a full 10-step Mantine scale so `color="purple"`
and `variant="filled"` resolve correctly, with `primaryColor` set to it
and `primaryShade` pinned so the brand hex is what actually renders.

**Restraint rule.** Purple marks actions, focus, and the active nav item.
Everything else is near-black and grey. Numbers stay white. Purple on
every surface reads as parody, not as Twitch — this single rule is what
separates a considered theme from a loud one.

### Color scheme

`MantineProvider` gets `forceColorScheme="dark"`, and `index.html` sets
`data-mantine-color-scheme="dark"` on `<html>` so there is no
light-to-dark flash before React mounts.

### Typography

- **Inter** for UI text.
- **JetBrains Mono** for every number: balances, gains, uptime, log lines,
  device code. Tabular figures, so a ticking uptime does not jitter.

Both self-hosted via `@fontsource` packages. No Google Fonts CDN call:
this is a LAN tool and must render correctly with no internet access.

### Files

- `src/theme.ts` — Mantine theme object (colors, fonts, radii, component
  defaults).
- `src/theme.css` — custom properties, base element styles, keyframes
  (live pulse, card lift, unlock shake), scrollbar styling.
- Component-level CSS modules where a component needs styles Mantine's
  props cannot express.

## App shell

### Sidebar (240px, `--tw-surface`)

Three zones:

**Identity.** Purple pickaxe-and-coin mark beside "MINER CONTROL" in
tight uppercase.

**Navigation.** A custom `NavItem` component, not stock `NavLink` — the
active state is the personality and stock `NavLink` cannot express it: a
4px purple bar flush to the left edge, `--tw-surface-alt` fill, white
label. Inactive rows are `--tw-text-dim`, lifting to near-white on hover.
Each row carries a Tabler icon (tree-shaken imports, not the full pack).

Two badges carry live state into the nav so it is not dead chrome:

- **Streamers** — count of currently-live channels, in the red live pill.
- **Account** — a purple dot when `loginRequired` is true.

The account dot **replaces the yellow alert banner** currently rendered
above every screen. The nav states it permanently without consuming
vertical space on the dashboard.

**Miner dock.** Pinned to the sidebar foot: full-width Stop/Restart
buttons and the error line. It is the app's most important control and the
one piece of state true on every screen. In the header it was cramped to
`size="xs"` with the error truncated to `maw={180}` behind a tooltip; in
the dock the error gets a real, readable line.

### Header (slim)

Current screen title on the left. On the right, **read-only** miner status:
state badge and monospace uptime, plus a live-connection indicator driven
by `useLiveState`'s `connected` flag — which the UI currently computes and
then ignores entirely.

### Split of MinerControls

`MinerControls` splits into two components over one shared state (already
lifted into `app.tsx`, so both simply read it):

- `MinerStatusBadge` (header, read-only) — owns `miner-state` and
  `miner-uptime` testids, and the 1s tick that keeps uptime moving.
- `MinerDock` (sidebar, actions) — owns `miner-toggle`, `miner-restart`
  and `miner-error`, and the per-action busy state so only the pressed
  button spins.

The existing `TRANSITIONAL` set and `isUp` logic move to a shared module;
both components import it. No behaviour changes.

### Responsive

Below `sm` the sidebar becomes a slide-over opened by a header burger. The
miner dock moves into the slide-over with it; the header badge is always
visible, so miner state is never hidden behind a menu.

## Unlock screen

Full-bleed `--tw-bg` with a slow-drifting purple radial gradient behind a
centered 400px card.

Above the card, our SVG mark at ~96px: a pickaxe striking a Twitch
channel-points coin, purple and amber, the coin holding a slight rotation
on load. Below it "MINER CONTROL" in tight tracking and a dim "Twitch
Channel Points" line.

Password field with a purple focus ring; full-width purple Unlock button.
A wrong password **shakes the card** rather than inserting a red `Alert`
that reflows the layout. The error still renders with `role="alert"` for
assistive tech — `PasswordGate.test.tsx` asserts on the "Wrong password"
text, which must keep working.

## Twitch account screen

The device code becomes the focus: large monospace characters in a
bordered, purple-tinted panel with a copy button and a **live countdown**
derived from `expiresAt` — currently fetched from the API and never shown,
so a user cannot tell a fresh code from a dead one.

The pending state gets a pulsing indicator beside "Waiting for you to
enter the code…" instead of plain static text.

The username form, `USERNAME_RE` validation, and the save-before-spawn
ordering in `signIn()` are untouched. That ordering is load-bearing (the
helper reads `TWITCH_USERNAME` at spawn time) and is documented in place.

## Dashboard

### KPI row

Four stat tiles: Total points, 24h gain (green/red with a direction
arrow), Live now, Tracked. Large monospace numbers, dim uppercase labels,
hairline purple top accent.

The `—` versus `0` distinction in `Dashboard.tsx` is preserved exactly.
That logic is load-bearing — "we have not looked yet" must never render as
a confident `0` — and its comment stays with it.

### Streamer cards

`--tw-surface` with a hairline that turns purple on hover, and a slight
lift. Live cards get a red LIVE pill with a pulsing dot and a faint red
top edge, so live/offline is readable before a single word is.

Layout: name and status on one line; large monospace balance; gains
beneath; sparkline spanning the card's **full width** as a soft area fill
under the line, replacing the fixed 88px bare stroke.

`Sparkline` gains an optional area fill and responsive width. Its
degenerate cases stay: fewer than 2 points renders nothing, and a flat
series pins to the midline rather than dividing by a zero range.

Offline cards drop to ~60% opacity in a denser grid — reference, not
focus. Section headers become dim uppercase "LIVE NOW · 3" / "OFFLINE · 9"
with a hairline rule.

### Activity feed

A right-hand column on wide screens, so a live dashboard has something
moving in view. Below `lg` it moves underneath the cards in normal flow.

**Toggle.** A control in the dashboard header switches the feed off. When
off, the feed does not render **and does not poll** — the `setInterval`
and the `/api/events` request live behind the enabled flag, so switching
it off genuinely stops the network traffic rather than hiding a component
that keeps fetching every 5 seconds. The preference persists in
`localStorage` and is read once on mount.

Rows stay monospace (they are the miner's own log lines and their columns
align when the glyphs do), with a purple left-edge accent on points
events and right-aligned dim relative timestamps.

The existing "a 200 carrying the wrong shape is as much a failure as a
rejected request" guard and the silent-failure stance (an ancillary panel
must not raise an alert beside numbers that loaded fine) both stay.

## Streamers

Cards collapse into one grouped list panel. Each row: drag handle,
position number, name, purple switch.

Real drag-to-reorder via HTML5 drag events. **The ↑ button stays** — it is
the keyboard-accessible path, and `Streamers.test.tsx` drives reordering
through its "Move up" label.

Because the miner watches only the top two, the **top two rows get a
purple-tinted background and a "WATCHING" tag**. The priority rule becomes
visible instead of a sentence the user has to remember.

`AddStreamer` becomes a search-styled input with an inline button.

`countChanges` and the apply flow are untouched.

## Logs

A real terminal panel: `--tw-bg` inset, JetBrains Mono, per-line level
colouring (ERROR red, WARNING amber, INFO dim, points gains green),
autoscroll pinned to the bottom with a "jump to latest" pill appearing
when the user has scrolled up, and a filter box.

Full viewport height rather than the current fixed `h={600}`.

The transient-error handling stays as written: a later successful poll
clears an earlier failure, so one hiccup does not leave a permanent banner
over a log that is flowing again.

## Settings

`Switch` and `Radio.Group` wrapped in labelled setting cards with
descriptions, so the screen stops reading as a bare form.

## PendingBar

Currently a full-width `radius={0}` strip welded to the bottom edge.
Becomes a floating pill: centered, rounded, elevated, purple Apply button,
slide-up entrance, with a warning icon since applying restarts the miner.

## Testing

Test-first, per the project convention. Every existing suite must stay
green, with one deliberate exception.

**Testids preserved:** `total-points`, `live-heading`, `streamer-*`,
`balance`, `gain-stream`, `gain-24h`, `points-disabled`, `staleness`,
`streamer-row`, `pending-bar`, `miner-state`, `miner-uptime`,
`miner-toggle`, `miner-restart`, `miner-error`.

**Deliberate change:** `login-required-banner` disappears with the banner
it names. `app.test.tsx` asserts on it at two places and is updated to
assert the nav account indicator instead — same requirement, new
affordance.

**New tests:**

- Feed toggle: when off, no `/api/events` request is made (assert on the
  fetch mock, not on absence of DOM — the point is that polling stops).
- Feed toggle preference survives a remount.
- Device-code countdown renders and decrements.
- `MinerStatusBadge` and `MinerDock` render their halves independently.
- Log level colouring maps lines to the right class.

**Verification:** `pnpm test` (all suites), `pnpm build` (Mantine 9
typecheck), then `pnpm dev` with screenshots of every screen in live and
offline states at desktop and mobile widths, checking real contrast
against the actual palette.

## Out of scope

- Twitch profile avatars — needs a backend endpoint and cache; the user
  chose the UI-only path.
- Light theme.
- Any backend change. This is a frontend-only overhaul.

## Risks

- **Mantine 9's solid `light` variants** change badge appearance. Measured
  as low-impact: badges are being restyled anyway.
- **`AppShell` internals** may have shifted between 8 and 9 in ways the
  migration guide does not enumerate. First implementation task is the
  version bump plus a full test and build run, so any surprise surfaces
  before design work is layered on top.
- **Feed side column** adds a responsive breakpoint that the dashboard
  tests render through jsdom, which has no layout. Tests assert on
  presence and on polling behaviour, never on computed position.
