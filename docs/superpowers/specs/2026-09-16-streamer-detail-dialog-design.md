# Streamer detail dialog: the history SQLite already holds

Status: proposed
Date: 2026-09-16

## Problem

The dashboard card is a good glance and nothing more. It answers "is this
channel live, what is the balance, is it earning right now" in 320px, and
every addition to it has had to fight for that width — the grid comment in
`StreamerCard.tsx:63-72` is a record of that fight, as is `StreamerMeta`'s
existence (`StreamerMeta.tsx:16-23`: signals moved off the title row so the
name could keep its width).

Meanwhile the backend has been recording per-streamer history since the
first release and almost none of it is reachable. There is no screen that
answers:

- What has this channel's balance actually done over a month?
- How much did each individual stream earn?
- When was this channel live and *not* being mined?
- What has happened on this channel specifically, rather than across the
  whole roster?

All four are answerable from tables that already exist and are already
pruned, indexed and tested. The data has no reader.

## Goal

A detail dialog, opened from a card, that reads the existing history and
reports it honestly. No new recording, no schema change, no new source of
truth — this is a reader for `point_snapshots`, `events`,
`streamer_sessions` and `miner_sessions`.

The hard constraint, inherited from the card and non-negotiable here:
**never assert a figure the data does not support.** The distinction
`Gain` draws in `StreamerCard.tsx:36` — `null` renders an em-dash, never
"+0", because "nothing earned" and "nothing known" are different claims —
applies to every figure in this dialog.

## Why a dialog and not an expandable card

Considered and rejected: expanding the card in place.

The grid is `auto-fill` against a 320px minimum (`Dashboard.tsx:43`, and
the comment above it explains what a fixed column count cost last time).
An expanding card reflows every card after it, so the page jumps under the
cursor — and it caps the content at one column's width, which is between
320px and roughly 550px. A per-stream table and a chart with axes do not
read at that width.

A right-hand drawer was the near miss: it keeps the grid visible, which is
genuinely nice when stepping through several streamers. It loses about
half the chart width. Chose the modal.

## Scope

In:

| Block | Source |
|---|---|
| Header + stat row | `StreamerState`, already in the snapshot |
| Points chart, 24h/7d/30d/all | `point_snapshots` |
| Per-stream table | `streamer_sessions` + `point_snapshots` |
| Activity log for this channel | `events` (the `streamer` column) |
| Mining coverage timeline | `streamer_sessions` ∩ `miner_sessions` |

Out, deliberately:

- **Live updates while open.** The dialog is one fetch on open. Reconciling
  an SSE frame against fetched history is real work for a view that is read
  for thirty seconds.
- **A URL per streamer.** There is no router — `app.tsx` switches on a
  `ScreenKey`. Adding routing to make a modal linkable is a separate job.
- **Write actions.** Settings stay in `StreamerSettingsModal`.
- **Comparing streamers.**

## What the data actually supports

Verified against the schema and the state pipeline, not from memory.

| Fact | Where it comes from | Caveat |
|---|---|---|
| Balance over time | `point_snapshots` | Change-only writes; pruned at 90d |
| Points earned per stream | `anchor_points` + `balanceAt(end)` | `anchor_points` is nullable |
| Stream start/end | `streamer_sessions` | `start_ts` is Twitch's `createdAt` |
| Mined time | `streamerSpans ∩ minerSpans` | Must be floored by `first_seen_ts` |
| Per-channel events | `events.streamer` | Attributed at write time; nullable |
| Event amounts | `parseActivity` | Balance in the message is lossy |

Five constraints follow, and each one is a wrong number if ignored:

**1. Writes are change-only.** `recordPoints` inserts only when the balance
moves (`history.ts:11-18`). A flat week is two rows. A line chart
interpolating between them draws gradual earning across days when nothing
happened — so the series renders as a step, not a slope. The balance
genuinely was flat and then jumped.

**2. Retention truncates "all".** `point_snapshots` prunes at 90 days by
default (`retention.ts:1`), and it is the only table pruned — the session
tables are kept precisely because dropping rows would corrupt the all-time
mining figure (`retention.ts:6-11`). So the "all" range is *all we kept*,
and the chart says so rather than letting a two-year-old channel look
newly tracked.

**3. `first_seen_ts` floors every mining figure.** `streamer_sessions.start_ts`
is Twitch's own `createdAt`, so a channel added mid-stream opens a session
back-dated to a start we were never present for — and the miner, up the
whole time, agrees. Both clocks are right and the intersection is still
wrong. `service.ts:651-661` already solves this for the card's figures;
the per-session figures reuse the same floor. Without it, the first stream
of every newly added channel reports its full length as mined.

**4. `anchor_points` is nullable.** A session row written before a balance
was known has no anchor, and `earned` is then unknowable — not zero. That
column renders an em-dash, per the constraint in the Goal.

**5. Message balances are lossy.** `history.ts:78-81` and the parser doc in
`parseActivity.ts:20-23`: the balance inside a miner log line went through
`millify()` and reads "12.3k". The *earned* amount is an exact integer from
PubSub and is safe. The activity log shows amounts via `parseActivity` and
sums nothing.

## Backend

### Endpoint

`/api/history` already takes a streamer and a range, and already validates
both against `usernameSchema` and `finiteParam` (`server.ts:428-447`). It
is also half-built: it returns `deps.history.recentEvents(100)` — the
**global** feed, ignoring the streamer it was just given. That looks like an
oversight rather than a decision.

It has no frontend consumer. `grep` finds it only in `server.ts` and
`server.test.ts`. So it is repointed rather than duplicated — this is a
prototype and back-compat is not a constraint.

```
GET /api/history?streamer=<login>&from=<ms>&to=<ms>

{
  series:   [{ ts, balance }],
  events:   [{ ts, type, message }],       // this streamer only
  sessions: [{ streamId, start, end, mined, earned }],
  coverage: { live: [{start, end}], mined: [{start, end}] },
  firstSeen: number | null,
  retentionFloor: number | null            // oldest kept sample, or null
}
```

One response, not four. The dialog opens once and needs all of it; four
round trips would give four independent loading states for one view.

The client computes `from`/`to` from the selected range — the route already
validates them as finite numbers and nothing about that changes. "All"
sends `from=0`; the server answers with whatever survived pruning and
reports the oldest kept sample as `retentionFloor`, so the client can say
what the window really covers instead of inferring it from the first
datapoint.

The existing validation and its tests stay exactly as they are — the four
400-path tests in `server.test.ts:328-352` still apply unchanged.

### New `History` methods

Following the prepared-statement style of the existing class:

- `eventsFor(streamer, limit)` — the per-streamer query the class never
  had. `lastActivity` (`history.ts:99`) already does this with `LIMIT 1`;
  this is the same query without the limit.
- `sessionsFor(streamer, fromTs)` — session rows including `anchor_points`,
  newest first.

`earned` per session is `balanceAt(end ?? now) - anchor_points`, null when
the anchor is. `balanceAt` is the right reader and `latest` is not: writes
are change-only, so the balance in force at a session's end is the most
recent snapshot *at or before* it (`history.ts:29-35`).

`mined` per session is `total(intersect(clip([session], floor, end), minerSpans))`,
with `floor = firstSeen ?? 0` — composed exactly as `service.ts:655-661`
composes it.

## Frontend

### Opening it

The card gets a click handler, `role="button"`, `tabIndex={0}` and
Enter/Space. The handler bails when the event originates inside an
interactive element, because the card already contains two: the name
anchor to twitch.tv (`StreamerCard.tsx:87-97`) and the goal disclosure
(`StreamerMeta.tsx:109`). Clicking either must do what it does today.

`Dashboard` holds one `openStreamer: string | null` and renders one modal.
Not one modal per card — a 50-streamer roster would mount 50 dialogs.

### The dialog

`size="xl"`. Header from the `StreamerState` passed in as a prop, so it
paints instantly and only the fetched blocks wait; it reuses
`StreamerAvatar` and `StatusPill` rather than restyling them.

**Points chart.** Mantine `AreaChart`, `curveType="step"` per constraint 1,
with a 24h/7d/30d/all segmented control. Two views over one series:
cumulative balance (default — "where am I") and gain per bucket as bars
("when was this channel actually earning"). A cumulative line alone is
nearly flat at most zooms and hides the thing worth seeing. On "all", a
dimmed caption names the retention floor.

**Per-stream table.** Date, length, mined, earned, coverage %. Newest
first, capped at 20 with the total count shown. A low-coverage row is
marked — it is the one actionable signal in the dialog.

**Activity log.** `eventsFor(login, 100)` in a `ScrollArea`, grouped by
day, each row through `parseActivity` so the wording matches the card's
LAST line exactly.

**Coverage timeline.** A row per day, each an SVG band: live stretches in
one tone, the mined subset overlaid. Hand-rolled, not Recharts — it is a
Gantt-like band, not a chart type Recharts does well. This is the block
that earns the dialog: it shows points being lost, which nothing in the
current UI reports.

Empty states are per-block. A channel added yesterday has a chart and no
stream history, and that is not an error.

### Charts

`@mantine/charts@9.6.x` (matching the installed `@mantine/core` 9.6.0) plus
its `recharts >= 3.2.1` peer, with `@mantine/charts/styles.css` imported
after core styles in `main.tsx:1`.

**Recharts renders nothing under jsdom, and this must not produce green
tests.** `ResponsiveContainer` sizes itself from `ResizeObserver` and
`getBoundingClientRect`; the first is a no-op stub that never fires a
callback (`test-setup.ts`, ResizeObserver block) and the second is jsdom's
own, which reports 0x0 for every element — the reason `stubRowRects`
exists at all (`test-utils.tsx:38-44`). A test asserting "the chart
rendered" would pass against an empty SVG — the exact false-green the rest
of that setup is written to prevent.

Two consequences, both binding:

1. Charts take explicit `w`/`h`, not responsive sizing.
2. **Chart correctness is tested on the data, not the DOM.**

## Testing

Every transform is a pure function in `lib/`, tested directly — the shape
`sortStreamers.ts` and `rollingHistory.ts` already use:

| Module | What it must prove |
|---|---|
| `bucketPoints.ts` | Step interpretation of change-only writes; bucketing per range; differencing for the gain view; empty and single-sample series |
| `sessionRows.ts` | `earned` null when the anchor is null, never 0; `mined` floored by `firstSeen`; an open session (`end_ts` null) |
| `coverageRows.ts` | Day splitting across midnight; a stream spanning two days; live-but-unmined stretches |

Component tests cover behaviour, not pixels: opens on click, opens on
Enter, does **not** open when the name link is clicked, closes on Escape,
renders per-block empty states. Mantine overlays are fine under vitest;
modal content is queried with `{ hidden: true }`.

Backend: `eventsFor` and `sessionsFor` against an in-memory db as
`history.test.ts` does, plus the reshaped `/api/history` — including that
its events are now scoped to the streamer, which is the bug being fixed.

## Order

1. Backend queries + endpoint reshape
2. `bucketPoints`, `sessionRows`, `coverageRows` with their tests
3. Modal shell + card trigger + fetch
4. Points chart
5. Per-stream table
6. Activity log
7. Coverage timeline

Each step is independently testable and leaves the app working. The
coverage timeline is last because it is the most speculative of the four.

## Known overlaps

Two, recorded rather than resolved:

- The points chart and the coverage timeline both answer "was this channel
  earning" from different angles. If the dialog feels crowded in use, the
  chart's gain view is the redundant half.
- The activity log is the block most duplicated by the dashboard's existing
  `EventsFeed` — the difference is only that it is scoped to one channel.

If this needs trimming, the per-stream table and the coverage timeline are
the pair carrying information that exists nowhere else in the UI.
