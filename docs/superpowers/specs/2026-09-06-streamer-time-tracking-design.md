# Streamer time tracking

Status: approved design, not yet implemented
Date: 2026-09-06

The online cards show a balance, a sparkline and two gain figures. They
say nothing about *time*: how long a channel has been live, when the
miner last did something for it, or how much of the last day it actually
spent mining. This adds those, and the efficiency figure that falls out
of having them.

## Goals

Per streamer, on the dashboard card:

1. How long the channel has been live (online cards).
2. The last mining activity: what it was, and how long ago.
3. Online and mining time over the last 24h, as two separate figures.
4. Total mining time, all-time.
5. Points per hour mined.
6. When a channel was last live (offline cards).

Plus a retention policy for `point_snapshots`, which today grows without
bound.

## The distinction that drives the design

**Online time** is how long the channel was live. **Mining time** is how
much of that we were actually there for: live *and* the miner process
up. They differ whenever the miner is stopped, crashed, restarting, or
the backend was down.

Conflating them would silently inflate every historical figure and make
points-per-hour flattering rather than useful. Two clocks are the whole
point: "live 8h · mined 6h" says something "8h" alone cannot.

## What exists today

- `point_snapshots (streamer, ts, balance)` -- written change-only by the
  state poller, every ~60s tick where a balance moved.
- `events (ts, type, message)` -- **global**. No streamer column. The
  streamer's name survives only inside the miner's formatted display
  text, whose balances are millified and lossy, and which
  `python/helpers/doorbell.py` explicitly warns must never be parsed back
  into numbers.
- `StateService.streamAnchor` -- an **in-memory** map of the balance each
  streamer had when it last went online. Reset on every restart.
- `Supervisor.runningSince` -- when the live miner process started, or
  null. In memory; emits `state` transitions.

Nothing about online periods or miner uptime is persisted anywhere: both
live in memory and die with the process.

### Twitch already tells us when the stream started

`state.py:_one()` calls `with_is_stream_live_query` on every poll and
reduces the whole response to a boolean:

```python
live = self.session.gql.with_is_stream_live_query(channel.id)
"isOnline": live.user.stream is not None,   # everything else discarded
```

That `Stream` object carries `id` and `created_at` -- Twitch's own
authoritative stream start time, already parsed by the miner's typed
parser (`vendor/miner/.../response/WithIsStreamLiveQuery.py`). We fetch
it every 60 seconds and throw it away.

This is **better than deriving the same figure from observed
transitions**, which is what an earlier draft of this design did:

- It is correct on *first* observation. A transition-derived clock can
  only measure from the moment we first looked, so a streamer added
  mid-stream would report "live 4m" for a stream running six hours.
- It survives restarts for free -- no boot recovery, no last-known-good
  timestamp, no systematic under-count.
- `stream.id` is a stable identity for the current stream, which is a
  sounder anchor than an in-memory map that empties on restart.

So the current stream's duration comes from Twitch, and the span tables
below are reduced to what only they can answer: history.

## Design

### 0. The division of labour

Twitch answers **"now"**; the span tables answer **"history"**.

`created_at` is a point-in-time fact about the *current* stream. It says
nothing about streams that have ended, and Twitch does not hand us past
stream durations. So it cannot answer:

- Online time in the last 24h -- potentially several streams, most of
  them over.
- Mining time -- needs miner uptime, which Twitch knows nothing about.
- All-time mined -- same.

Hence both halves. The tables stay, but they get *better*: their rows are
stamped with Twitch's real stream boundaries rather than with the moment
our poller happened to notice, so the historical figures inherit the same
accuracy as the live one.

### 1. Spans, not samples

Store *spans*. A span table answers "how long in the last 24h" and "how
long overall" with one query each, and survives restarts. Sampling
`isOnline` into rows and reconstructing intervals later would store far
more and answer worse.

```sql
CREATE TABLE streamer_sessions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer  TEXT    NOT NULL,
  -- Twitch's stream id. The row's identity: one row per real stream,
  -- no matter how many times we restart while it runs.
  stream_id TEXT    NOT NULL,
  -- Twitch's own createdAt, not when our poller first looked.
  start_ts  INTEGER NOT NULL,
  end_ts    INTEGER,         -- NULL = still live
  -- Balance at our first sighting of this stream; the gainedStream
  -- anchor, persisted so a restart cannot reset it (see 5b).
  anchor_points INTEGER,
  UNIQUE (streamer, stream_id)
);
CREATE INDEX idx_streamer_sessions_lookup
  ON streamer_sessions (streamer, start_ts);

CREATE TABLE miner_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts   INTEGER NOT NULL,
  end_ts     INTEGER,        -- NULL = still running
  heartbeat  INTEGER NOT NULL
);
CREATE INDEX idx_miner_sessions_start ON miner_sessions (start_ts);
```

`streamer_sessions` is written by the state poller on every tick where a
streamer is live, as an upsert keyed on `(streamer, stream_id)`: insert
the row on the first sighting of a stream, and leave it alone thereafter.
A stream whose id is no longer live gets its `end_ts` stamped.

The upsert is what makes this restart-proof. It is not a transition
detector -- it does not care whether we *saw* the stream begin. A backend
that boots mid-stream finds the same `stream_id` it stored before and
updates that row rather than opening a second one, and a stream first
seen four hours in is still recorded with its true start.

`miner_sessions` is written by the supervisor from its `state`
transitions: a row opens on entry to RUNNING and closes on leaving it.
This one *is* transition-driven, because miner uptime is our own fact
with no external source of truth.

### 2. Deriving the numbers

- **Online time in window** = sum of `streamer_sessions` spans clipped to
  the window.
- **Mining time in window** = sum of the *intersection* of that
  streamer's spans with `miner_sessions` spans, clipped to the window.
- **Total mining time** = the same intersection over all time.
- **Points per hour** = points gained in the window / mining hours in the
  window.

Clipping and intersection are pure functions over two sorted span lists,
in a new `apps/backend/src/state/spans.ts`. They are the highest-value
unit tests in this work: every displayed duration is downstream of them.

Open spans (`end_ts IS NULL`) are treated as ending *now* at read time.
They are never written as ending now -- see below.

Points per hour is suppressed below a floor of 15 minutes mined in the
window. Dividing a handful of points by six minutes produces a confident
four-digit rate that the next tick contradicts; the figure is only
meaningful once there is enough denominator to be stable.

### 3. Crash recovery

An open span is a claim that something is still running, and a killed
process leaves that claim growing unattended. This is the single most
likely way for this feature to produce confidently wrong numbers, so
each table gets an explicit answer -- and they are different answers,
because only one of the two has an external source of truth.

**`streamer_sessions` needs no recovery.** Anchoring on `stream_id`
removes the problem rather than handling it: on the first poll after a
restart, a stream still live matches its existing row and continues it,
and one that ended is absent from the response and gets closed. The open
span was never a guess to begin with -- it was Twitch's fact, and Twitch
is still there to confirm or retire it.

The one case needing care: a stream that ended *while we were down* is
closed at the first post-boot poll, which over-counts by the downtime.
Clamp it to `MIN(now, MAX(point_snapshots.ts for that streamer))` -- the
last moment we were demonstrably watching -- so the row closes where our
evidence stops rather than where our outage ended.

**`miner_sessions` does need recovery**, because miner uptime has no
external source of truth. On boot, close any open row at its `heartbeat`
(below), never at boot time: otherwise an 8-hour-old open span from a
killed process silently becomes 8 hours of mining that never happened.

This under-counts a clean shutdown by up to one poll interval, which is
the correct direction to err: a mining figure that is slightly low is a
mild inaccuracy, one that is high is a lie.

### 4. Miner heartbeat

The supervisor knows when the miner started but writes nothing
periodically, so a hard kill would lose up to a full poll interval.

The open `miner_sessions` row carries a `heartbeat` column, refreshed on
each state-poll tick while the miner is RUNNING. No new timer: the poller
already runs on the interval this needs, and adding a second timebase
would mean two things to reason about when they disagree.

Cost is one UPDATE of one row per tick.

### 5. Last mining activity -- events need a streamer

This cannot come from spans; it needs the event log, and `events` is
global. The streamer exists only inside display text that must not be
parsed.

Add a `streamer` column to `events`, populated at write time by matching
the doorbell's message against **the active roster**, which the backend
already holds in memory. Matching a message against a known list of
logins is a different operation from parsing values out of it: the set of
candidates is closed and known, so a match is an identification, not an
interpretation. Balances are still never parsed.

Rows matching nothing keep `streamer = NULL` and behave exactly as today.
Matching is case-insensitive on a word boundary, and a message matching
two roster logins is recorded as NULL rather than attributed to a guess.

Added via the same `PRAGMA table_info` guard already in
`apps/backend/src/db/schema.ts` (which `events.message` established). Old
rows keep NULL; no backfill, consistent with the project's
prototype/no-back-compat stance.

`lastActivity` is then the newest `events` row for that streamer:
`{ ts, type }`. The raw message is not sent to the card -- the feed
already renders those, and the card wants a short label.

### 5b. Fixing `gainedStream` while we are here

`gainedStream` currently anchors on `StateService.streamAnchor`, an
in-memory map populated only on an observed false->true transition. It
has two bugs that `streamId` fixes for free, so this design closes them
rather than building alongside them:

- A backend restart mid-stream empties the map, so the per-stream gain
  silently resets to zero and the card under-reports for the rest of the
  stream.
- A streamer added mid-stream never had a transition observed, so it
  shows no stream gain at all until the *next* stream.

Replace the map with an anchor persisted per `(streamer, stream_id)`:
the balance at the first sighting of that stream, stored on the
`streamer_sessions` row as `anchor_points INTEGER`. Restart-proof,
and correct from the first poll of a stream we joined late.

This changes an existing behaviour, so `service.test.ts`'s
`gainedStream` cases need updating rather than merely still passing --
called out here because it is the one place this design edits semantics
instead of adding them.

### 6. Retention

`point_snapshots` grows without bound and is the only table that grows
per-tick. Add pruning, configurable via `.env` alongside the other
operational tunables (`STOP_GRACE_MS` is the precedent; `config.json` is
for user-facing miner settings and is the wrong home for this):

    HISTORY_RETENTION_DAYS=90    # 0 disables pruning

Pruning runs on boot and daily thereafter, deleting `point_snapshots`
rows older than the cutoff, then `VACUUM`ing when a prune actually
deleted anything.

**The span tables are not pruned.** They are the source of the all-time
mining figure, and they are tiny -- a few rows per streamer per day
against a snapshot per tick. Pruning them would corrupt the very number
they exist to answer. `events` is left alone in this work; it is bounded
in practice and out of scope here.

The one interaction worth stating: pruning `point_snapshots` past a
streamer's earliest sample changes what `gainWindow` falls back to. Since
retention defaults to 90 days and the gain window is 24h, this cannot
bite at any sane setting, but a retention below 1 day would degrade gain
labels. The loader clamps to a minimum of 1 day when a non-zero value is
given.

### 7. State shape

`state.py:_one()` gains two fields, straight from the response it
already fetches:

```python
stream = live.user.stream
"streamId": stream.id if stream else None,
"streamStartedAt": int(stream.created_at.timestamp() * 1000) if stream else None,
```

`created_at` is a **timezone-aware** `datetime` (Twitch sends UTC with a
`Z` suffix, and `expect_iso_8601` preserves the offset), so
`.timestamp()` is unambiguous. It must be converted here rather than
passed through: `datetime` is not JSON-serializable and would throw when
the NDJSON response is written. Epoch milliseconds also match every
other timestamp already crossing this boundary.

Both are on `RawStreamerState`, so they arrive before the service derives
anything.

New fields on `StreamerState`:

```ts
liveSince: number | null;        // Twitch's stream start; null when offline
streamId: string | null;         // identity of the current stream
lastLive: number | null;         // end of the most recent closed span
lastActivity: { ts: number; type: string } | null;
online24h: number;               // ms
mined24h: number;                // ms
minedTotal: number;              // ms
pointsPerHour: number | null;    // null below the mining floor
```

`liveSince` is a *timestamp*, not a duration, so the card can tick it
client-side. Sending a duration would change the payload every tick and
wake every SSE client with a frame nothing meaningfully changed in --
the same reasoning that keeps `gainedSince` null on a full window.

For the same reason every derived duration is quantized before it reaches
the snapshot: `online24h`, `mined24h` and `minedTotal` to the nearest
minute, and `pointsPerHour` to one decimal place. Unrounded, each of them
changes on every single tick by definition -- an open span always grows --
and would defeat the change-comparison that gates SSE emission, making
every tick a broadcast to every client. The quantization is what keeps a
frame meaning "something happened".

### 8. Card UI

Under the sparkline, a compact block:

```
● LIVE 3h 24m                    last: claim 4m ago
24h  live 8h · mined 6h                 all-time 142h
```

- Live duration ticks client-side from `liveSince`, like the header
  uptime already does.
- The 24h line renders `live 8h · mined 6h` only when the two differ by
  more than a rounding step; otherwise it collapses to a single figure.
  Showing "live 6h · mined 6h" on every card is noise -- the gap is the
  signal.
- Points per hour sits with the existing gain figures, suppressed when
  null.
- Offline cards replace the LIVE row with `last seen live 2d ago` from
  `lastLive`. This is the current weakest spot on the dashboard: an
  offline card today shows a balance and nothing else.
- A streamer with no history yet renders nothing rather than zeros. "0h
  mined" and "we have not been watching yet" are different claims, and
  the em-dash convention already established for `gained24h` applies.

Durations use the existing `formatSpan` (coarse, single-unit, for the
24h figures and the "ago" qualifiers) and `formatUptime` (padded, for the
ticking live duration).

`formatSpan` needs one extension for the all-time figure: it currently
tops out at hours, so a long-tracked streamer would read "1400h" instead
of "58d". Add a day rollover above 48h, keeping the existing single-unit
style ("58d", not "58d 8h"). Below 48h the current behaviour is
unchanged, so no existing caller is affected -- the 24h figures and gain
labels never reach the new branch. `formatUptime` needs no change; it
already handles days.

## Out of scope: watch-streak / next-drop progress

Investigated and deliberately deferred, with a finding worth recording.

Upstream supports watch streaks, but the progress state
(`watch_streak_missing`, `minute_watched_requests`) lives on `Streamer`
objects **inside the miner's own process memory**. Our state pipeline
(`python/helpers/state.py`) talks to Twitch's GQL API directly and never
touches those objects. The doorbell is one-way and carries only formatted
log text.

So this is not a query we are missing -- it needs a new channel into the
running miner process. That is its own piece of work with its own design,
and folding it in here would expand this from "persist what we already
observe" into "add IPC to the miner".

Also considered and rejected: a per-streamer sparkline of online time.
Online time is blocky and near-binary; it would render as a bar code that
says less than the `live 8h · mined 6h` line does.

## Testing

- `spans.ts`: clipping, intersection, open-span handling, zero-length and
  adjacent spans, spans straddling the window edge. Pure functions, so
  these are cheap and carry the most risk.
- Stream identity: a restart mid-stream continues the same row rather
  than opening a second; a streamer first seen four hours into a stream
  records Twitch's true start, not the sighting time.
- Boot recovery: an open `miner_sessions` row from a killed process
  closes at its heartbeat, not at boot. A stream that ended during
  downtime closes at the last snapshot, not at the post-boot poll.
- `gainedStream`: survives a restart mid-stream (the current bug), and
  is correct for a streamer added mid-stream.
- Event attribution: a message naming a roster streamer attributes; one
  naming none stays NULL; one naming two stays NULL.
- Retention: rows past the cutoff go, rows inside stay, `0` disables,
  a sub-day value clamps.
- Card: live, offline, and no-history states; the collapsing 24h line;
  points-per-hour suppression below the floor.
- `formatSpan` day rollover: unchanged below 48h (guarding existing
  callers), rolls to days above it.

Existing suites: `history.test.ts` and `supervisor.test.ts` must keep
passing. `service.test.ts` needs its `gainedStream` cases *rewritten* --
5b deliberately changes that behaviour, so a passing old test there would
mean the fix did not land. `python/tests/test_contract.py` gains a case
pinning `Stream.created_at`, since we now depend on it.

## Implementation order

1. `state.py` returns `streamId` / `streamStartedAt`; contract test for
   `created_at`. Everything else depends on this.
2. `spans.ts` pure functions + tests.
3. Schema: two tables, the `events.streamer` column, the migration guard.
4. `History` methods for spans, boot recovery, pruning.
5. Poller upserts streamer spans; supervisor writes miner spans + heartbeat.
6. Move `gainedStream` onto the persisted anchor (5b).
7. Event attribution against the roster.
8. Derive the new `StreamerState` fields.
9. `formatSpan` day rollover.
10. Card UI.
11. `.env.example` documentation for `HISTORY_RETENTION_DAYS`.

Step 1 gates everything. Steps 2-4 are then independent of 5-8 and could
be built in parallel; the card is last because it is the only step that
cannot be verified without the rest.
