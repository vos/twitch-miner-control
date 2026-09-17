# Drop campaigns: browse them, and subscribe to collecting them

Status: proposed
Date: 2026-09-17

## Problem

The miner already collects drops, and the dashboard already reports
progress on them — `state/drops.ts` fetches the next unclaimed drop per
channel, `dropsEligible.ts` decides which channels are worth asking
about, and the card renders a bar. All of it is keyed by **your roster**:
it answers "what is this streamer I already watch earning me right now".

Nothing answers the question that comes first:

- What drop campaigns are running at all?
- What do they award, and how many minutes does each drop cost?
- Which of them have I already finished, started, or never touched?
- If I want the rewards from one, **who do I have to watch?**

Today that last question is answered by opening
`twitch.tv/drops/campaigns` in a browser, reading a campaign, finding a
live channel playing the game with drops enabled, and adding it to the
streamer list by hand — then remembering to take it out when the campaign
ends. The app has every piece needed to do this itself and does none of
it.

## Goal

A **Drops** section that lists every running campaign with its drops and
your progress, and lets you *subscribe* to a campaign or a game so the
app keeps suitable channels in the miner's config for as long as the
campaign runs.

Two halves, deliberately built as one spec because the second is useless
without the first's data:

1. **The browser** — read-only. Campaign catalogue, filters, per-drop
   state including your own progress.
2. **The subscription engine** — resolves a subscription's *intent* into
   concrete channels, writes them into the config as marked temporary
   entries, and restarts the miner only when it must.

The constraint inherited from the dashboard applies throughout: **never
assert a figure the data does not support.** A drop whose progress could
not be fetched renders as unknown, not as zero. This is the same
distinction `Gain.tsx:30` draws — `null` renders an em-dash rather than
a confident zero, as `StreamerCard.tsx:120` does for points — and it matters more
here because an absent inventory entry and a failed inventory fetch look
identical if you are careless.

## What Twitch actually gives us

This is not the public Helix API. Helix has no drops-campaign endpoint;
its Drops Entitlements API is for game developers reading entitlements
they themselves granted. The only route is Twitch's private GraphQL
layer, authenticated with the miner's session cookie — and the vendored
miner already speaks it.

Three operations carry the whole feature, all three already present in
`vendor/miner`:

- **`ViewerDropsDashboard`** (`constants.py:145`) — the query backing
  `twitch.tv/drops/campaigns`. Returns **every** campaign with an id and
  status, not only campaigns for channels you follow. Reached through
  `gql.get_viewer_drops_dashboard()`, used today at `Twitch.py:1361`.
- **`DropCampaignDetails`** (`constants.py:156`) — batched by id.
  Yields `name`, `status`, `game` (id/slug/display name), `start_at`,
  `end_at`, `allow_channel_ids`, and `time_based_drops[]` where each
  drop carries `name`, `benefits`, `required_minutes_watched`,
  `required_subs` and its own window. This is the entire browser payload.
- **`Inventory`** (`constants.py:125`) — global, one call, covering every
  campaign you have made progress on across all channels. Each
  `TimeBasedDropInProgress` carries a `SelfEdge` with
  `current_minutes_watched`, `drop_instance_id` and `is_claimed`.

What is **missing**: there is no operation anywhere in `constants.py`
that lists live channels for a game. `allow_channel_ids` covers
allowlisted campaigns only; the common case — "any channel streaming this
game with drops enabled" — has no query behind it. See *The directory
query* below, which is the load-bearing risk of this design.

## Three clocks, not one

The single most important structural decision here. These three facts
change at wildly different rates, and conflating them produces either a
stale UI or a request storm against the account you are willing to lose.

| Data | TTL | Persisted? | Cost |
|---|---|---|---|
| Campaign catalogue | 24h | Yes, disk | 1 dashboard call + batched details |
| Inventory progress | 10 min | **No** | 1 global call |
| Resolved channel pools | timer, ~15 min | Yes, in config | directory calls |

**The catalogue is nearly static.** Campaigns are announced days ahead
and run for weeks; `required_minutes_watched` for a drop never changes
once published. A 24h TTL is generous and still correct, and it defuses
the cost problem: there can be 100+ active campaigns, and fetching
details for all of them per page load would hammer Twitch. Once a day, it
does not.

It is persisted to disk because every field in it stays true across a
restart. This is the opposite call from `state/drops.ts`, and
deliberately so — that module's own docstring explains why progress is
held in memory only: *"reloaded from disk after a restart it would
describe whatever was true when the process last ran."* Campaign
metadata has no such problem.

**Progress is live and must not be persisted.** It follows
`DROPS_TTL_MS` (600_000) for exactly the reason that constant documents:
drop progress moves in 30/60/120-minute steps, so ten minutes is
invisible in the UI while keeping the call count sane.

Because the two clocks differ so widely, **the UI shows both ages
separately**. A three-minute-old progress bar sitting under a
twenty-hour-old campaign list is correct, but rendering one "updated N
ago" for the pair of them reads as a bug.

## The campaign catalogue

A new `campaigns` op in `python/helpers/state.py`, beside the existing
`drops` op (`state.py:273`). It calls `get_viewer_drops_dashboard()`,
filters to `ACTIVE`, batch-fetches details, and flattens to JSON — the
same shape of work `_drops` already does, and it inherits that module's
conventions: every field read with `getattr` so a miner build whose
parser predates a field degrades to a missing value rather than failing
the batch, and `datetime` converted to epoch ms because it is not JSON
serialisable and would otherwise raise inside `serve()`'s `json.dumps`
(the bug `_next_drop` already documents).

A second op, `inventory`, returns the global inventory keyed by campaign
id and drop id. It is separate from `campaigns` because it is on a
different clock — merging them would force the cheap frequent call and
the expensive rare one to run together.

Note that `_drops`'s expensive half — `get_available_drops` per channel —
is **not** needed here. That query answers "which campaigns is this
channel running", which is a roster question. The Drops page asks "what
is my progress in campaign X", which the global inventory answers
outright. Progress on this page therefore costs one call, not one per
channel.

### Manual refresh

A POST that bypasses the TTL and rebroadcasts over SSE. Guarded by a
minimum interval (60s) between manual refreshes, so a double-click cannot
fire two full detail sweeps. The UI shows the catalogue's age beside the
button, so staleness is visible rather than guessed at.

### Failure behaviour

A failed catalogue fetch **serves the stale cache with its age shown**.
It never empties the page. An expired cache that cannot be refreshed is
still the best information available, and a campaign list from yesterday
is overwhelmingly still correct.

## Drop state

Each drop renders in exactly one state, joined from catalogue + inventory
by campaign id and drop id:

| State | Determined by |
|---|---|
| **Unobtainable** | `required_subs > 0` |
| **Claimed** | `self_edge.is_claimed` |
| **Ready to claim** | `drop_instance_id` set, not claimed |
| **In progress** | `current_minutes_watched > 0` |
| **Not started** | no inventory entry for the drop id |
| **Unknown** | inventory fetch failed |

**Unobtainable overrides everything.** `Drop.update` sets `is_claimable`
false whenever `subs_required > 0` (`entities/Drop.py`), so these drops
can never be earned by watching. Rendering them as merely "not started"
would mean "collect all drops" silently never completes, and the user
would never learn why.

**Unknown is not "not started".** Absence from the inventory legitimately
means the campaign was never begun — the inventory only holds campaigns
you have started. But if the inventory *call fails*, every drop is
absent, and reading that as not-started would fill the page with
confident zeros. When the inventory is unavailable the page renders
metadata only, with no bars and an explicit notice.

Campaign-level state aggregates its drops: **fully collected**,
**partially collected**, or **untouched**. This is what you actually scan
the list for when deciding what to subscribe to, and the subscription
engine reuses it to skip campaigns already finished.

## The Drops page

Lists campaigns from the catalogue, each expandable to its drops with
required minutes, benefits and state. Filters by name and by game, since
the list runs long.

It is a pure reader of the catalogue and inventory caches and performs no
fetching of its own. Filtering is client-side over the cached list; with
a few hundred campaigns there is nothing to gain from a server round trip
and a great deal to lose in responsiveness.

## Subscriptions

A subscription stores **intent, never channels**: a campaign id or a
game, a pool size (default 3, configurable), and a rank.

**Order is user-controlled and load-bearing.** The miner watches a
limited number of channels concurrently. When subscriptions compete for
those slots, the higher-ranked subscription fills first, and rank
determines the order temporary entries are written into the config —
which is exactly what upstream's `priority_order` consumes. The UI uses
the same drag-to-reorder idiom as the streamer list.

### Pool size, and why it mostly solves restarts

A subscription resolves to **N channels at once**, not one. This is the
design's main lever against restart churn: the miner's own
`StreamerSelector` picks among the live ones each cycle, and
`priority_drops` (`StreamerSelector.py`) already prefers channels with a
claimable drop. **One channel going offline therefore needs no restart at
all** — the miner moves down its own list. A restart is needed only when
the whole pool is stale or exhausted.

Default 3 balances redundancy against config bloat — enough that a
single channel ending its stream is absorbed silently, few enough that
several subscriptions do not crowd out the roster. Configurable per
subscription (1-10), because a campaign restricted to two channels and a
campaign covering a whole game are different problems.

### The reconciliation timer

Resolution runs on a ~15 minute timer. This is the cadence at which a
*whole pool* can go stale, not the cadence at which channels go offline —
the pool absorbs that without help. Fifteen minutes is well under the
shortest meaningful drop (30 minutes), so a fully-dead pool costs at most
half a drop's progress, and it is long enough that the directory query is
not being polled aggressively.

A pass that finds nothing to change costs no restart and no config write.

### Temporary streamer entries

Resolved channels are written into the streamer config marked as
subscription-owned, carrying the id of the subscription that added them.
They appear in the normal streamer list with a badge naming the campaign,
and cannot be hand-edited — the engine owns them and would overwrite the
edit on its next pass.

They are removed when the campaign ends or the subscription is deleted.
The streamer list continues to reflect what the miner actually watches,
which is the property that makes the dashboard trustworthy.

## The three modules

Split this way because the restart logic is where bugs will breed, and it
deserves to be pure.

**Resolution** — `(campaign, directory data, allowlist) → ranked
candidate channels`. Network in, decision out. Ranking prefers channels
that are live, have drops enabled for the campaign's game, and are not
already in the roster for other reasons.

**Reconciliation** — `(desired temp entries, current config) → diff +
whether a restart is required`. A pure function: no network, no clock, no
I/O. Given the same inputs it returns the same answer, so it can be
exhaustively tested against fixtures. Crucially it decides *whether a
restart is needed at all* — if the resolved set equals what is already in
the config, nothing happens, which is the common case on most passes.

**Catalogue cache** — the 24h disk store, its TTL, and manual refresh.

Each is independently testable and none needs to know the others'
internals.

## Deferred restart

When reconciliation says a restart is required, the engine **does not
call `supervisor.restart()`**. It publishes a pending restart with a 60s
countdown over the existing SSE channel (`http/sse.ts`). The dashboard
shows a banner with **Cancel** and **Restart now**.

This lives entirely *above* the supervisor. `miner/supervisor.ts` has
careful generation-tracking and crash-backoff reasoning
(`supervisor.ts:116`, `:309`) that this feature has no business touching;
the deferral is an intent the subscription engine holds, not a new
supervisor state.

Two behaviours decided deliberately:

**An unattended timer still fires.** If nobody cancels, the restart
happens at expiry. The alternative — waiting for a human — means
subscriptions silently stop working on a box nobody is watching, which is
the normal case for this app.

**Cancel applies to that pending restart only.** The subscription is
marked as having unapplied changes, and the next reconciliation pass will
propose a fresh restart rather than staying cancelled forever. A cancel
is "not right now", not "never".

## The directory query

**This is the risk in this design, and it should be understood before
implementation starts.**

Resolving "any channel streaming this game with drops enabled" needs a
live-channel directory query. The miner does not have one —
`constants.py` contains no directory or game-listing operation. We must
add a persisted query hash that upstream does not maintain, and Twitch
rotates these hashes at will.

Mitigations, in order of importance:

**Allowlisted campaigns never depend on it.** Campaigns publishing
`allow_channel_ids` resolve from catalogue data alone. These keep working
regardless.

**Degrade loudly.** When the directory query fails, existing pools stay
in the config untouched — subscriptions keep collecting from channels
already resolved — and the Drops page banners that game-based
subscription is unavailable. It never silently empties a pool, because
that would quietly stop drop collection with no visible cause.

**Isolate it.** The directory query lives behind one function in the
resolution module. When the hash rotates, one place changes.

## Testing

Following the module split:

- **Reconciliation** — pure unit tests over fixture configs and desired
  sets. The restart/no-restart decision is the highest-value assertion in
  the feature and needs exhaustive coverage: unchanged set, added
  channel, removed channel, reordered, campaign ended, subscription
  deleted.
- **Resolution** — fixture campaigns with and without
  `allow_channel_ids`, plus directory-unavailable.
- **Catalogue cache** — TTL expiry, disk round trip, stale-serve on fetch
  failure, manual-refresh rate limit.
- **Deferred restart** — fake timers for expire, cancel, restart-now, and
  cancel-then-next-pass-reproposes.
- **Drop state** — the six-state table above, including the
  unknown-vs-not-started distinction with a failing inventory.
- **Python helper ops** — `campaigns` and `inventory` against recorded
  GQL fixtures, including a response missing newer fields, matching how
  `_drops` is covered today.

Tests build day fixtures in local time; the suite has no TZ pin.

## Out of scope

- Claiming drops from the UI. The miner already claims them
  (`Twitch.py:claim_drop`, plus `claim_all_drops_from_inventory` on its
  own timer). A second claim path would race it.
- Historical campaigns. The catalogue holds `ACTIVE` only.
- Notifications when a campaign is about to end.
- Editing subscription-owned streamer entries by hand.
