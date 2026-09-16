# Local-first dashboard: render SQLite immediately, fill Twitch in after

Status: proposed
Date: 2026-09-16

## Problem

A cold start takes 3-4 seconds to show anything. The dashboard holds its
loading skeleton for the whole of it, and every figure it eventually
draws was already sitting in SQLite before the wait began.

The wait is `state.py`'s doing and not easily removed: `_state` issues
**one GQL call per streamer, sequentially** (`python/helpers/state.py:342`),
so a roster of eight is eight serial round trips, plus one per live
channel for drops. Only `_profiles` is batched into a single call.

Measured on the dev database (8 streamers):

| | time |
|---|---|
| Building all 8 cards from SQLite alone | **2.1 ms** |
| The Twitch pass those cards are waiting for | **3000-4000 ms** |

So the dashboard waits ~1500x longer than it needs to for data that is
mostly a confirmation of what is already on disk.

This is not the same problem as the idle-refresh split shipped alongside
it. That work stopped the backend deriving display fields when nobody is
watching. This one is about what to show in the seconds *after* someone
starts watching, before Twitch has answered.

## Goal

First paint from SQLite, in milliseconds. The Twitch pass then replaces
it over the existing SSE `state` channel.

The hard constraint: **the local frame must never assert something it
cannot know.** A slightly old points balance is fine. A channel shown as
LIVE when it went offline hours ago is not.

## What is actually local

Verified against `.devdata/history.db`, not from memory.

| Local (SQLite) | Twitch-only |
|---|---|
| `displayName` | `points` (current) |
| `avatarUrl` — cached, 7-day TTL | `isOnline`, `liveSince`, `streamId` |
| `points` (last known) | `viewers`, `game`, `streamTitle` |
| `gained24h`, `gainedSince`, `spark` | `drop` |
| `online24h`, `mined24h`, `minedTotal` | `multiplier`, `claimPending`, `goal` |
| `pointsPerHour`, `lastLive`, `lastActivity` | `pointsEnabled`, `watching`¹ |

¹ `watching` is derived locally from `lastWatchGain`, but its first
guard is `if (s.isOnline !== true) return false`
(`apps/backend/src/state/service.ts:635`). With `isOnline: null` in the
local frame it is therefore always `false`, so it behaves as Twitch-only
in practice. Correct by construction — the miner cannot be watching a
channel we cannot confirm is live — and it needs no special handling.

All 8 dev avatars are on disk (3 fetched today, 5 about 3 days old), so
on a warm restart avatars need no network at all. This is why the local
frame looks like a real dashboard rather than a wireframe.

The Twitch-only column maps exactly to `RawStreamerState`
(`apps/backend/src/state/service.ts:141`) minus the fields `History` and
`Streamers` can answer.

## The stale-liveness problem

This is the part that needs care, and it is not hypothetical. The dev
database right now holds **three open `streamer_sessions` for channels
no longer in the roster** — `trymacs`, `montanablack88`, `annitheducktv`
— left over from an earlier config. A naive local-first render would
show all three as live this second.

It is worse than a wrong badge. `Dashboard.tsx:198` groups on
`s.isOnline`, so liveness decides **which section a card appears in**. A
guessed value puts cards under "Live now" and then makes them jump when
the truth arrives.

### Resolution

`isOnline` is already `boolean | null` on both sides of the wire, and the
codebase already has the right instinct for the third state:
`StatusPill.tsx:34` renders nothing at all for `null`, because "an
OFFLINE pill is a claim we can't make."

The local frame sets `isOnline` from **the miner's own log**, which the
doorbell already records as `STREAMER_ONLINE` / `STREAMER_OFFLINE`
attributed to the streamer each line names. Upstream announces the whole
roster within about a second of the miner starting -- measured at 8
events in 0.4-1.0s across four restarts -- so this lands well before the
state pass.

A verdict is used only while **fresher than 15 minutes**
(`LIVENESS_TRUST_MS`). Nothing retracts the last verdict when the miner
stops, so an unbounded read would let a shutdown leave a channel showing
"Online!" indefinitely. Past the bound the field falls back to **null** —
not `false`, which would be just as much of a claim. Null already means
"we have not looked", and every consumer handles it.

An open `streamer_sessions` row is never sufficient on its own; it only
supplies the stream's start time once a fresh verdict has established
that the channel is live.

Consequences, all of which fall out of existing code:

- A channel with a fresh verdict renders exactly as it would after the
  Twitch pass: LIVE badge, uptime counting from the open session's
  start, and its place under "Live now".
- A channel whose verdict is missing or stale gets `isOnline: null`, so
  `StreamerCard.tsx:51` (`s.isOnline === true`) is false and
  `StatusPill.tsx:34` renders nothing rather than claiming OFFLINE.
- `Dashboard.tsx:198` groups on the same field, so such a channel sits
  outside "Live now" until the pass confirms it.

Verified against the dev database: all 8 channels resolved correctly
from the log alone (3 online, 5 offline), matching the miner's output
exactly, with no Twitch call.

`lastLive` stays populated, so a card can still say "last live 4h ago".
That is a statement about the past and is safely local.

## Shape of the change

### Backend

Split `doRefresh`'s two halves. It already has the seam: the idle-path
early return added in the previous change sits exactly where the local
data ends and the network data begins.

1. **`deriveLocal(usernames): StreamerState[]`** in `state/service.ts` —
   builds cards from `History` + `Streamers` only. No `client.request`,
   no `profiles`, no `drops`. Every Twitch-only field takes its null /
   empty value, `isOnline` included. This is the existing derivation
   with the raw-state inputs replaced by stored ones, so the arithmetic
   (`clip`/`intersect`/`total`, `gainWindow`, `downsample`) is reused,
   not rewritten.

2. **Emit it first.** When a refresh begins and `undrawn` is true, emit a
   `change` carrying the local build before awaiting the helper. The
   Twitch pass then emits its own `change` as it does today.

3. **`/api/streamers` returns the local build** instead of
   `{ ...snapshot, pending: true }`. `pending` stays in the payload as
   the flag meaning "a fuller frame is coming", but it no longer implies
   the body is empty — so the frontend can stop discarding it.

### Frontend

4. **`useLiveState.ts:250`** — stop dropping pending snapshots. Adopt
   them: they now carry real cards. The `!s.pending` guard added in the
   previous change is removed, and `Dashboard.tsx:173`'s skeleton branch
   stops being the thing that covers a cold start.

5. **`Streamers.tsx`** — same: adopt the local snapshot for its status
   pills. `isOnline: null` renders no pill, which is already correct
   behaviour there.

6. **A "confirming…" affordance** while `pending` is true — the honest
   signal that liveness is still unknown. Smallest version that works: a
   subtle line in the header, next to the existing freshness readout, not
   a per-card spinner.

### Not in scope

- Batching or parallelising `_state`'s per-streamer loop. That is the
  real fix for the 3-4s itself and deserves its own spec; this change
  makes the wait invisible rather than shorter.
- Persisting `viewers`, `game` or `streamTitle` to make them local.
  They are volatile by nature and a stale viewer count is worse than
  none.
- Any change to the idle-refresh split. This builds on it.

## Testing

- `deriveLocal` against a seeded DB: correct gains, sparkline, mining
  totals; `isOnline`, `viewers`, `drop`, `goal` all null.
- A streamer with an **open session but no recent poll** — the
  `trymacs` case — renders as not-live, not live.
- A cold start emits two `change` frames in order, the first local, the
  second derived, and the second wins.
- A streamer never seen before (no rows) yields a card with nulls
  rather than being dropped from the roster.
- Frontend: a `pending: true` snapshot with cards is adopted and
  rendered; "Live now" is empty rather than populated from it.

## Risks

- **An empty "Live now" reads as "nothing is live" rather than "not
  known yet".** Mitigated by the confirming affordance in (6); if that
  proves too subtle in practice, the fallback is a placeholder row in
  that section rather than inventing liveness.
- **Two `change` frames mean two renders.** The snapshot comparison in
  `doRefresh` (`before !== JSON.stringify(...)`) already suppresses a
  second frame when nothing differs, so a warm client sees one.
- **`deriveLocal` duplicating derivation logic.** It must call the same
  helpers rather than re-deriving; a second implementation of the
  mining-time intersection is exactly the conflation those three clocks
  exist to prevent.

## Estimate

Roughly a day. Most of it is `deriveLocal` and its tests; the frontend
side is deletions plus one small affordance.
