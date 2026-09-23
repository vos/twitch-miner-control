# Insights, living numbers and a command palette

Status: proposed
Date: 2026-09-23

## Problem

The app records a lot of history and shows almost none of it as a story.
The dashboard answers "what is happening now", the detail dialog answers
"what did this one channel do", and nothing answers:

- What has mining looked like across the year?
- How did this week go, compared with last week?
- When is a given channel usually live?

The dashboard also feels static: a balance that grew by 50 points simply
swaps one number for another, and the user has to diff it in their head.

Separately, every action is a click path. Opening a streamer means finding
its card; opening a campaign means going to Drops and searching; stopping
the miner means opening the sidebar.

## Goal

Four slices, each shippable on its own:

1. **Command palette** — Ctrl/⌘+K to find streamers and campaigns, run
   miner actions and navigate.
2. **Animated balances** — numbers roll to their new value, and a card
   that earned floats a small `+N`.
3. **Live-schedule heatmap** — a weekday × hour grid in the detail dialog
   showing when a channel is usually live.
4. **Insights screen** — a year calendar heatmap of points earned, and a
   weekly/monthly recap card that exports as a PNG.

Notifications are deliberately out of scope (see the end).

## The data layer

### Only points need a rollup

`streamer_sessions`, `miner_sessions` and `events` are never pruned
(`apps/backend/src/index.ts:150`). Hours mined, streams watched, bonus
claims, raids and drops are therefore always computable from raw rows.

`point_snapshots` is pruned after `HISTORY_RETENTION_DAYS` (90 by
default). A year calendar built from it would be mostly empty, so points
alone get a per-day rollup that is never pruned:

```sql
CREATE TABLE IF NOT EXISTS daily_points (
  day      TEXT    NOT NULL,   -- 'YYYY-MM-DD' in the server's local time
  streamer TEXT    NOT NULL,
  earned   INTEGER NOT NULL,
  PRIMARY KEY (day, streamer)
);
```

Size: one row per streamer per day, roughly 365 × roster per year.

### `earned`, not net

`earned` is the sum of the *positive* steps between consecutive balance
samples within the day. A reward redemption or a lost bet is a negative
step and is excluded, so a day on which the user spent 10k points does not
render as a hole in the calendar.

This differs from the dashboard's `gained24h`, which is net. Everything in
Insights is labelled "earned" so the two are never read as the same
figure.

The first sample of a day is compared against the last sample before the
day began, when one exists, so a step that lands just after midnight is
counted on the day it landed.

### When the rollup runs

`rollupDays(now)` writes every *complete* local day that has snapshots
and no `daily_points` rows yet. Written days are never recomputed: once a
day's snapshots are pruned, recomputing it would overwrite a correct row
with a partial one.

- At boot, which backfills whatever the retention window still holds.
- At the start of `prune()`, so a day is always rolled up before its
  snapshots are deleted. `prune()` already runs at boot and daily.

If `HISTORY_RETENTION_DAYS=0` (never prune) there is no `prune()`; the
rollup still runs at boot and on its own daily timer.

A day with no snapshots for a streamer writes no row for that streamer.
A day with no rows at all is a day with no data, which the calendar
distinguishes from a day with zero earned (see `since` below).

**Today** is never rolled up. The endpoints compute it live from
`point_snapshots` with the same function, so the calendar's last cell and
the current period's recap are always current.

### Mined time

Mined time reuses the existing three-clock intersection
(`apps/backend/src/state/service.ts:686`): channel live spans ∩ miner
spans, floored at the channel's `first_seen_ts`, clipped to the day or
period. Per channel (the recap's "most watched") that figure is used as
is, so it agrees with the cards.

Totals across channels (the recap's "mined" and the calendar's per-day
figure) are *time spent mining*: the union of every channel's mined
spans, so channels mined at the same moment count once and the total
never exceeds the miner's uptime. Adding the per-channel figures instead
counted every tracked channel that was live while the miner was up; on a
roster of ~50 channels that reported 387h mined in a week with 8h of
uptime, although Twitch only credits two channels at a time.

### Module

A new `apps/backend/src/insights/` module:

- `rollup.ts` — `earnedFor(samples, dayStart, dayEnd)` and `rollupDays`.
- `calendar.ts` — builds the calendar payload.
- `recap.ts` — builds the recap payload.

`db/history.ts` gains the small queries they need, following its existing
style. `server.ts` only parses parameters and calls in.

## Endpoints

### `GET /api/insights/calendar?days=365`

```ts
{
  days: Array<{
    date: string;            // 'YYYY-MM-DD'
    earned: number;
    minedMs: number;
    top: { login: string; earned: number } | null;
  }>;
  since: string | null;      // first day with any data
  streak: { current: number; longest: number };
}
```

- `days` defaults to 365 and is clamped to 1–730.
- `since` lets the client draw days before tracking began as "no data"
  rather than as zero.
- A streak is a run of consecutive days with `earned > 0`. `current`
  counts today only if today already has earned points; otherwise it
  counts back from yesterday, so the streak does not read 0 every
  morning.

### `GET /api/insights/recap?period=week|month&offset=0`

A week is an ISO week (Monday start); a month is a calendar month; both
in the server's local time. `offset` is 0 for the current period, −1 for
the one before, and so on (clamped to ≤ 0).

```ts
{
  period: { kind: "week" | "month"; from: number; to: number; partial: boolean };
  totals: Totals;
  previous: Totals | null;   // null when the previous period has no data
  top: Array<{ login: string; displayName: string | null;
               avatarUrl: string | null; earned: number; minedMs: number }>;
  mostWatched: { login: string; displayName: string | null;
                 avatarUrl: string | null; minedMs: number } | null;
  highlights: {
    bestDay: { date: string; earned: number } | null;
    longestStreak: number;
    bonusClaims: number;
    raids: number;
    dropsClaimed: number;
    watchStreakBonuses: number;
  };
}

interface Totals {
  earned: number;
  minedMs: number;
  streams: number;           // streamer sessions with mined time > 0
  uptimePct: number;         // miner up / period length (to now if partial)
}
```

- `top` is the three channels with the most earned points; `mostWatched`
  is the channel with the most mined time, and only set when it is not
  already in `top`.
- Highlight counts come from event types — `BONUS_CLAIM`, `JOIN_RAID`,
  `DROP_CLAIM`, `GAIN_FOR_WATCH_STREAK` — counted by `ts` in the period.
- Bet results are excluded: the miner records no structured win/loss
  event, only message text.

### `GET /api/streamers/:login/schedule`

```ts
{ since: number; spans: Array<{ start: number; end: number }> }
```

Raw `streamer_sessions` spans (an open session ends at now) for the last
12 weeks. `since` is the later of 12 weeks ago and the channel's
`first_seen_ts`. The client does the bucketing, in the browser's
timezone.

## Slice 1: Command palette

### Setup

- Add `@mantine/spotlight`, pinned to the installed `@mantine/core`
  version, and import its stylesheet beside core's.
- Mounted once inside `Shell`, which only renders behind `PasswordGate`,
  so the shortcut can never fire on the login screen.
- Opens on Ctrl/⌘+K, and from a header button (`Search… ⌘K`) placed left
  of the connection dot; on narrow screens the button is the icon alone.

### Result groups

At most 5 items per group.

| Group | Items | On select |
|---|---|---|
| Streamers | Tracked channels from the live `snapshot`; live ones first, with a red dot and viewer count | Opens the detail dialog over the current screen |
| Campaigns | Matched on game, campaign or drop name. `/api/campaigns` is fetched the first time the palette opens and kept for the session | Navigates to Drops and opens that campaign |
| Actions | Start / Stop / Restart miner, only those the current state allows. "Add '<query>' as streamer" when the query parses (`parseStreamerInput`) to a login not already tracked | Miner actions call `/api/miner/:action` and pass the result to `setMiner`. Add navigates to Streamers with the input prefilled but not submitted — adding is a staged draft that still needs Apply |
| Go to | Every screen, plus "Insights: this week" and "Insights: this month" once Insights exists | `navigate()` |

With an empty query the order is Go to, Live streamers, Actions. With a
query it is Streamers, Campaigns, Actions, Go to.

### Confirmation

Choosing Stop or Restart replaces the list with a one-line consequence
("Stop the miner? It will stop collecting points") and two items,
Confirm and Cancel. Esc from this state returns to the list rather than
closing the palette. Start needs no confirmation.

### Refactor: the detail dialog moves to `Shell`

`StreamerDetailModal` and its `openLogin` state currently live in
`Dashboard`. They move to `Shell`, which passes `openStreamer(login)` to
screens through `ScreenProps`. The Dashboard behaves exactly as before;
the palette can now open a streamer from any screen without leaving it.
The lazy import and the `detailUsed` gate move with it.

### Refactor: navigation takes params

`navigate(key, params?)`. Params are one-shot: a screen consumes them on
arrival, and a later navigation to the same screen without params does
not replay them.

- Drops: `{ campaign: string }` — sets `jumpedTo` (`Drops.tsx:587`) once
  the catalogue has loaded, and scrolls the card into view.
- Streamers: `{ prefill: string }` — the initial value of `AddStreamer`'s
  input.
- Insights: `{ period: "week" | "month" }`.

## Slice 2: Animated balances

### Rolling numbers

`useAnimatedNumber(value, { animate })` eases from the previous value to
the new one over 600ms using `requestAnimationFrame` (ease-out).
`RollingNumber` renders it with `tabular-nums` so the width does not
jitter. Used for:

- the card balance (`StreamerCard.tsx:120`)
- the Total points stat tile
- the detail dialog balance

A change animates only when all of these hold; otherwise the value snaps:

- Neither the previous nor the new snapshot is `pending`. The SQLite
  first frame's jump to Twitch's figure is a correction, not a gain.
- Both values are non-null.
- The tab was visible for both frames. The first frame after a
  `visibilitychange` back to visible snaps.
- `prefers-reduced-motion` is not set.

The rolling digits are `aria-hidden`; a visually hidden span holds the
final value, so screen readers never announce intermediate frames.

### Floating gain

On a positive change that animates, a card shows `+N` in
`--tw-success` beside its balance, rising ~16px and fading over 1.2s (a
CSS keyframe). A second gain during the float replaces the first. There
is no float for decreases — spending is not a celebration — and none on
the Total tile, since the cards already show where the points came from.
The float is removed entirely under `prefers-reduced-motion`, using the
same media query as `StreamerCard.module.css:174`.

## Slice 3: Live-schedule heatmap

`LiveScheduleGrid`, in the detail dialog below `CoverageTimeline`, under
the heading "Usually live · last 12 weeks". The heading states its own
window because the dialog's range control does not govern it.

- Fetched from `/api/streamers/:login/schedule` once per dialog open,
  not on range changes. Hidden in Activity view, like the other history
  sections.
- Buckets: 7 rows (Mon–Sun) × 24 columns in the browser's timezone. A
  cell's value is the fraction of observed weeks in which the channel
  was live at any point in that hour. Observed weeks are counted from
  `since`, so a channel tracked for 3 weeks is not scored out of 12.
- ~16px cells, hour labels at 0 / 6 / 12 / 18, the Insights purple ramp.
- Tooltip: "Tuesdays 20:00–21:00 · live 9 of 12 weeks".
- The current hour-of-week cell has an outline.
- Under 2 weeks of observation it shows "Needs a couple of weeks of
  tracking" instead of the grid.

## Slice 4: Insights screen

### Placement

A new `insights` entry in `SCREENS` (`app.tsx:29`) and the sidebar's
`ITEMS`, between Drops and Logs, with `IconSparkles`. The screen is
lazy-loaded. No dashboard tile links to it; the sidebar and palette are
enough.

```
┌ Insights ───────────────────────────────────────────────────────┐
│  🔥 12-day streak · longest 31    412,380 earned in the last year │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │ calendar heatmap: 53 weeks × 7 days, Monday first         │   │
│  └───────────────────────────────────────────────────────────┘   │
│   less ░▒▓█ more        hatched = before tracking began          │
│                                                                  │
│  RECAP ─────────────────────  [ Week | Month ]  ‹  Sep 15–21  ›  │
│  ┌──────────── recap card ────────────┐  [⤓ PNG]                 │
│  └────────────────────────────────────┘                          │
└──────────────────────────────────────────────────────────────────┘
```

### Calendar

- Mantine `Heatmap` from `@mantine/charts`, `firstDayOfWeek={1}`.
- A 5-step ramp of `--tw-purple` over `--tw-surface-alt`. The step
  thresholds are quantiles of the user's own non-zero days, so a heavy
  roster does not saturate every cell. `Heatmap`'s own `colors` scale is
  linear across the domain, so the fill is set per cell through
  `getRectProps` instead.
- Days before `since` are hatched, not empty: `getRectProps` sets
  `fill="url(#insights-hatch)"`, a pattern defined once in a hidden
  inline SVG on the screen (a `url(#id)` resolves across inline SVGs in
  the same document).
- Tooltip through `getTooltipLabel`: "Tue 16 Sep · 8,420 earned ·
  6h 12m mined · top: AlphaTV".
- Clicking a day (an `onClick` from `getRectProps`) sets the recap below
  to the week containing it.
- Below the `sm` breakpoint it shows the most recent ~26 weeks in a
  horizontal scroll, starting scrolled to the right.

### Recap card

A fixed 600px-wide composition, so the exported PNG is identical at any
window size.

```
┌────────────────────────────────────────────────────┐
│ ✦ WEEK OF SEP 15–21 · 2026                 [brand] │
│                                                    │
│   48,210            31h 40m          94%           │
│   points earned     mined            miner uptime  │
│   ▲ 12% vs last week  ▲ 3h          ▼ 2pts         │
│                                                    │
│   TOP CHANNELS                                     │
│   🥇 (avatar) AlphaTV      18,400                  │
│   🥈 (avatar) BetaGG       11,020                  │
│   🥉 (avatar) Gamma         7,310                  │
│   most watched: DeltaLive · 12h                    │
│                                                    │
│   Best day Thu · 9,880   🎁 42 chests   ⚔ 3 raids  │
│   🏆 1 drop claimed      🔥 5-day streak           │
└────────────────────────────────────────────────────┘
```

- A subtle purple gradient background and the existing `BrandMark`.
- A partial (current) period is titled "so far" and shows no change
  arrows: a partial week against a full one would always read as a drop.
  Arrows are also omitted when `previous` is null.
- Highlights with a zero count are hidden rather than shown as "0 raids".
- Period navigation: the Week/Month control plus ‹ › arrows; › is
  disabled at offset 0.

### PNG export

The Export button lazily imports `modern-screenshot`, renders the card
node at 2× scale and downloads `twitch-miner-week-2026-09-15.png` (or
`-month-2026-09.png`). Twitch's avatar CDN sends
`Access-Control-Allow-Origin: *`, so avatars are loaded with
`crossOrigin="anonymous"` and do not taint the capture. The button shows
a spinner while it works; a failure shows a notification and nothing
else changes.

### Empty and error states

- No data yet: "Not enough history yet — Insights fill in as the miner
  runs."
- Fetch error: an inline red `Alert`, as on the other screens.

## Build order

Each slice lands as its own commit(s) and works on its own:

1. Command palette and the two refactors. Frontend only.
2. Animated balances. Frontend only.
3. Live-schedule heatmap: the schedule endpoint and the grid.
4. Rollup, endpoints and the Insights screen, then the palette's
   Insights entries.

## Testing

Backend:

- `earnedFor`: positive steps only; the first step of a day compared
  against the previous day's last sample; an empty day.
- `rollupDays`: local-day boundaries (fixtures built in local time — the
  suite runs in the container's timezone); today never rolled up;
  written days never recomputed; runs before pruning.
- Calendar and recap builders against a seeded in-memory DB: streak
  counting across today/yesterday, `since`, `mostWatched` suppression,
  highlight counts, partial periods, `previous: null`.
- Route tests for all three endpoints, including parameter clamping, in
  the existing `server.test.ts` style.

Frontend:

- Palette: the shortcut opens it; grouping and ordering with and without
  a query; stop confirmation, Esc back to the list, the API call; add
  prefill; campaign jump. Overlay options are queried with
  `{ hidden: true }`.
- Dashboard tests updated for the dialog's move to `Shell`.
- `useAnimatedNumber` with rAF and `matchMedia` mocked: snaps on pending,
  on a hidden tab and under reduced motion.
- Floating gain appears on an increase, not on a decrease.
- Schedule bucketing: a span crossing midnight, one crossing the week
  boundary, observed weeks counted from `since`.
- Calendar: quantile steps, hatching before `since`, day click → week.
- Recap card: zero highlights hidden, no arrows when partial or without
  `previous`; export with `modern-screenshot` mocked.

## Out of scope

- **Notifications** (browser or webhook). Planned separately.
- **Bet statistics.** There is no structured win/loss event; parsing the
  miner's message text is too fragile for a headline figure.
- **A dashboard teaser tile** for Insights.
- **An animations toggle.** Reduced motion is honoured through the OS
  setting.
