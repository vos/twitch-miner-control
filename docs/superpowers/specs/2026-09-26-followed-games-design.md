# Followed games: subscribe to a game's campaigns as they appear

Status: Approved design, not yet implemented
Date: 2026-09-26

## Problem

The Drops page subscribes to one campaign at a time. To collect every
campaign a game runs, the user has to notice each new one in the
catalogue and subscribe to it by hand.

The backend already has a `game` subscription kind, but nothing in the
UI creates one, and it does something else: it keeps a pool of live
channels for the game at all times, campaign or not, outside the campaign
queue. Its only other use is the `campaign.new` notification, which has
therefore never fired in practice.

## Goal

Let the user **follow** one or more games, found through a search against
Twitch's category catalogue. Whenever a followed game has a drop
campaign, the app subscribes to that campaign automatically. The result
is an ordinary campaign subscription: it follows the campaign queue, can
be reordered and removed, and ends when the campaign ends or completes.

Followed games mine nothing themselves. The existing `game` subscription
kind is removed rather than kept alongside. This is a prototype with no
back-compat constraint, and no UI ever created one.

## Twitch category search

Twitch's GQL endpoint answers plain (non-persisted) queries for category
search and game lookup with no login, using the web client ID
`kimne78kx3ncx6brgo4mv6wki5h1ko`. Verified 2026-09-26:

```graphql
query {
  searchCategories(query: "rust", first: 10) {
    edges { node { id name displayName slug boxArtURL(width: 144, height: 192) } }
  }
  game(id: "263490") { id displayName slug boxArtURL(width: 144, height: 192) }
}
```

Because the query is plain rather than persisted, there is no hash to
rotate. That is unlike the directory query in `python/helpers/state.py`.

The game IDs are the same IDs the campaign catalogue carries
(`campaign.game.id`; ELDEN RING is `512953` in both), so the engine can
match campaigns to followed games by ID.

**The search runs in the Node backend, not the Python helper.** It needs
no session, so it works before login and while the miner is stopped. The
helper serves one request at a time, and a directory lookup takes
seconds, so search-as-you-type through the helper would stall while the
engine resolves. The backend already fetches the campaign catalogue
directly, so a second direct source adds no new kind of dependency.

## Config

`subscriptionSchema` loses `kind`. Every subscription is now a campaign
subscription, and `targetId` is always a campaign ID. Every
`kind === "game"` branch goes with it: `target()` in
`drops/resolution.ts`, the game cases in `drops/queue.ts` and in
`gameForSubscription` (backend and frontend), and the queue tooltip's
"Game subscriptions are not queued." sentence.

Every subscription saved before this change carries `kind: "campaign"`,
because the old schema required it. `loadConfig` drops that tag when
reading, so existing configs keep loading; any other `kind` is still
rejected.

Campaign subscriptions gain an optional `viaGame: string`, the ID of
the followed game that created them. It drives the Auto badge and tells
the engine which game's `skipped` list to update.

A new top-level list:

```ts
followedGames: z.array(z.object({
  /** Twitch game id; matches Campaign.game.id. */
  id: z.string().min(1),
  /** Display name, as Twitch returned it when followed. */
  name: z.string().min(1),
  slug: z.string(),
  boxArtUrl: z.string().nullable(),
  /** Copied onto each campaign subscription this game creates. */
  poolSize: z.number().int().min(1).max(10).default(3),
  /** Campaign ids this game must not subscribe to again. */
  skipped: z.array(z.string().min(1)).default([]),
}).strict()).default([])   // refined: unique by id
```

`name`, `slug` and `boxArtUrl` always come from Twitch (see API), never
from the browser. Python ignores `followedGames` and `viaGame`, as it
already ignores `subscriptions` and `ownedBy`.

## Engine

### The follow step

This is a new step in `SubscriptionEngine.pass()`. It runs after the
catalogue and inventory are read and before the existing ended/complete
checks. It is a pure function in its own module (`drops/follow.ts`),
`(config, catalogue, inventory, now) → { added, skippedChanges }`, which
the engine applies.

For each followed game, for each catalogue campaign whose `game.id`
matches, add a campaign subscription when **all** of these hold:

- no subscription has that campaign as its `targetId`;
- the campaign ID is not in the game's `skipped`;
- `endsAt` is null or in the future;
- the inventory is unavailable, or `resolveCampaign(campaign, inventory)`
  is not `complete` (a complete one is recorded in `skipped` instead, so
  a later pass that cannot read progress does not add it);
- at least one drop is obtainable by watching, using the existing
  unobtainable rules in `state/dropState.ts` (`requiredSubs > 0`,
  `requiredMinutes <= 0`, `preconditionsMet === false`).

The new subscription is `{ id: <new>, targetId: campaign.id, label:
campaign.name, poolSize: game.poolSize, rank: <after the current last>,
viaGame: game.id }`. When several are added in one pass, they are
appended in catalogue order.

A campaign that has not opened yet is added immediately. The queue
already marks it `scheduled`, as it would a manual subscription.

**Catalogue trust.** Nothing is added when the catalogue is unavailable.
A stale catalogue may still add campaigns, because the `endsAt` check
filters out finished ones and a stale list is otherwise still correct.

All additions and `skipped` changes are saved in **one** config write.
The rest of the pass then runs on the updated config, so new
subscriptions get channels in the same pass.

### Remembering what not to re-add

When a subscription with `viaGame` leaves, for any reason, its
`targetId` is appended to that game's `skipped` list in the same write
that removes it:

- removed by the user (`POST /api/subscriptions/:id/remove`);
- ended or gone from the catalogue (engine);
- 100% complete (engine).

Recording completion matters. Otherwise a later pass where the inventory
is unavailable would re-add a finished campaign.

If the followed game has been unfollowed in the meantime, there is no
list to record into, and nothing needs recording.

**Pruning.** On a pass with a trustworthy catalogue (available and not
stale), `skipped` entries whose campaign is no longer in the catalogue
are dropped. The list therefore only ever holds campaigns that are still
running.

### Unfollowing

Unfollowing removes the `followedGames` entry and nothing else. The
game's campaign subscriptions stay, since the user may be partway
through one, and keep their `viaGame` and Auto badge, which record where
they came from.

### Notification hook

`EngineDeps` gains `onCampaignFollowed?: (e: { subscriptionId, label,
targetId, game }) => void`, modelled on `onCampaignStarted`. It fires
once per added subscription that was saved, whatever started the pass,
except for games listed in the pass's `quietGames` option. The follow
route passes the games it just followed there: the user is looking at
the result. A campaign added during any other pass is news, even one the
user started for something unrelated. `PassTrigger` gains `"follow"`.

### Writing the pass

A pass reads the config, then spends seconds asking Twitch while routes
may save. It therefore re-reads the config before writing and applies
only its own decisions on top (`drops/rebase.ts`): subscriptions it
ended, additions whose game is still followed and has not skipped them,
its `skipped` changes, and the channels of the subscriptions it
considered. A follow, unfollow or removal made during a pass survives it.

## API

All routes sit behind the existing session auth.

| Route | Body | Result |
| --- | --- | --- |
| `GET /api/games/search?q=` | — | `{ games: [{ id, name, slug, boxArtUrl }] }` |
| `POST /api/followed-games` | `{ ids: string[] }` (1–25) | `{ added, alreadyFollowed, notFound }` |
| `POST /api/followed-games/:id/pool-size` | `{ poolSize }` | the updated game |
| `POST /api/followed-games/:id/remove` | — | `{ ok: true }` |

**Search.** Handled by `apps/backend/src/twitch/categories.ts`, which
exposes `searchCategories(query, first)` and `gameById(id)`. Both use a
5-second timeout and **throw** on a non-200 status, a GQL `errors` field
or a timeout; an empty result means only "no matches". The route:

- trims `q`, and returns `{ games: [] }` without calling Twitch when it
  is shorter than 2 characters;
- returns at most 10 results;
- when `q` is all digits, also calls `gameById(q)` and puts a hit first,
  without listing it twice;
- returns `502 { error }` when Twitch fails, so the UI never presents a
  failure as "no such game".

**Follow.** Each ID is looked up again with `gameById`, which is the
validation. An unknown ID goes into `notFound`, and one already followed
goes into `alreadyFollowed`. The rest are saved in one write with
`poolSize: 3` and `skipped: []`. If any were added, the route then runs
`engine.pass("follow")` (errors swallowed, as `POST /api/subscriptions`
does). If Twitch fails, the whole request returns 502 and nothing is
saved.

**Existing routes**

- `GET /api/subscriptions` gains a top-level `followedGames` array, so
  the Drops page needs no extra request. Each subscription row carries
  `viaGame` as stored.
- `POST /api/subscriptions` no longer takes `kind`. Its duplicate check
  compares `targetId` only.
- `POST /api/subscriptions/:id/remove` records the `skipped` entry
  described above.

## Drops page

### Followed games card

The card sits above the Subscriptions card. It is **always rendered**,
even with no subscriptions and while the catalogue is unavailable,
because search does not depend on the catalogue and the user has to be
able to follow a first game.

- Header: "Followed games" and a "Follow games" button that opens the
  dialog.
- Empty state: one line, "Follow a game to subscribe to its drop
  campaigns automatically as they appear."
- One row per game:
  - box art (`CampaignBoxArt`, sized via `sized()`);
  - the name, linked to `twitch.tv/directory/category/<slug>`;
  - "2 campaigns running" or "No campaigns right now", counted from the
    catalogue the page already holds;
  - the pool-size control, the same one subscription rows use;
  - a remove button.
- Rows are not draggable. Followed games have no rank.

### Follow games dialog

- A search input, debounced 300 ms, calling `/api/games/search`.
- Each result row shows box art, the name, the Twitch ID in dimmed small
  text (to tell apart games with similar names) and a checkbox.
- Games already followed show as ticked and disabled, labelled
  "Following".
- A result with campaigns in the catalogue shows a small "2 campaigns"
  hint.
- Ticked games collect as chips above the results and survive new
  searches, so "rust" and then "elden" can be picked in one go.
- Three distinct empty states:
  - under 2 characters: "Type a game name or Twitch ID";
  - no results: "No matching games";
  - 502: "Twitch search is unavailable — try again shortly".
- Confirm reads "Follow N games". On success the dialog closes and a
  Mantine notification says, for example, "Following 3 games · 2
  campaigns subscribed". The campaign count is the difference in
  subscriptions before and after the refetch.

### Auto badge

A subscription row with `viaGame` shows a small **Auto** badge. The row
already shows the game name beside the campaign label, so repeating the
game in the badge would say it twice. Its tooltip reads: "Added because
you follow ‹Game›. Removing it skips this campaign; future campaigns for
the game are still added." The game name comes from `followedGames`, or
from the catalogue when the game has since been unfollowed.

### Skipping and unskipping

A subscription whose campaign belongs to a followed game shows **Skip**
instead of **Remove**; the server does the same thing either way, and
records the skip. Skipped campaigns stay listed at the bottom of the
Subscriptions card, dimmed, with a *skipped* badge and an **Unskip**
button (`POST /api/followed-games/:id/unskip { campaignId }`), which
takes the campaign out of `skipped` and runs a quiet pass so the game
subscribes to it again. Only campaigns still running, not complete and
not subscribed are listed. The Followed games row counts them
("· 1 skipped").

### Campaign card shortcut

Cards whose campaign has a game get a "Follow game" button beside
Subscribe, which posts `{ ids: [campaign.game.id] }`. For a game already
followed it becomes a disabled "Following game" label. It is hidden when
`campaign.game` is null. Following from a card also subscribes that
card's campaign, and every other running campaign for the game.

## Notifications

`campaign.new` moves from `CampaignWatcher` to the engine hook:

- `index.ts` wires `onCampaignFollowed` to publish `kind: campaign.new`,
  title "New campaign", body *"‹campaign›" for ‹game› was subscribed
  automatically.*, link `/?open=drops&campaign=<id>`, dedupe key
  `campaign.new:<campaignId>`.
- Catalogue entry: description "A campaign for a game you follow was
  subscribed automatically."; `defaultOn` changes from `false` to
  `true`.
- `CampaignWatcher` loses `announceNew`, its `known` baseline, the
  `wantsNew` gate and the `subscribedGames` dependency. Completed and
  ending-soon are unchanged.
- Campaigns skipped as complete or unobtainable are not announced.
- `campaign.started` still fires when an auto-added scheduled campaign
  opens or reaches the front of the queue.

## Testing

Test-first, in the `*.test.ts` files next to each module.

**Backend**

- `twitch/categories.test.ts`, with `fetch` stubbed:
  - parsing into `{ id, name, slug, boxArtUrl }`;
  - `errors`, non-200 and timeout throw;
  - an ID hit comes first and is not listed twice.
- `drops/follow.test.ts`, for every add/skip condition above:
  - skipped, already subscribed, ended, complete, unobtainable-only;
  - an unavailable catalogue adds nothing;
  - a stale catalogue still adds;
  - rank appending and `poolSize` inheritance;
  - pruning only against a trustworthy catalogue.
- `engine.test.ts`:
  - additions get channels in the same pass;
  - `skipped` is recorded on end and on completion;
  - `onCampaignFollowed` fires on `"timer"` and `"boot"` passes and not
    on `"follow"` or `"manual"`.
- `server.test.ts`:
  - search: short query, success and 502;
  - a batch follow with `added`, `alreadyFollowed` and `notFound`;
  - a Twitch failure saves nothing;
  - pool size, and unfollow leaves subscriptions in place;
  - subscription remove records `skipped`.
- The game-kind cases in `resolution`, `queue` and `server` tests are
  deleted, not adapted.
- `notify/sources/campaigns.test.ts`: the `announceNew` cases are removed.

**Frontend**

- Followed games card: rendered with no subscriptions, the campaign
  count, remove, and pool size.
- Dialog:
  - debounce, with fake timers;
  - picks survive a second search;
  - already-followed rows are disabled;
  - the three empty states;
  - the confirm count.
- The Auto badge and its tooltip.
- The card shortcut in both states.

**Real app**

- Run `pnpm build`, then run `dist/` under plain Node.
- Call `categories.ts` once by hand against live Twitch.
- Drive the app with Playwright:
  - follow a game that has a live campaign;
  - confirm the campaign appears with the Auto badge and gets channels;
  - remove it, run a pass, and confirm it stays gone;
  - send screenshots of the card, the dialog and the badge.

## Out of scope

- Ranking by game ("Game A's campaigns before Game B's"). New campaigns
  append, and the user reorders.
- Following a game in order to mine it without a campaign. That was the
  old `game` kind, removed here.
- Caching search results. The dialog's debounce keeps the request rate
  low.
