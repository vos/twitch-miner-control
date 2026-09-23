# Notifications: an inbox, browser push, ntfy and Telegram

Status: proposed
Date: 2026-09-23

## Problem

The app runs for days with no browser open, and the things worth knowing
about happen while nobody is looking:

- The miner crashes, or crash-loops until the supervisor gives up.
- The Twitch session expires, and the miner collects nothing until
  someone signs in again.
- The drops engine proposes a restart. The existing 60-second countdown
  can only be cancelled by someone who happens to have the dashboard open.
- A drop is claimed, a campaign completes, or one is about to end with
  progress still unclaimed.
- A chosen streamer goes live.

Today the only way out of the app is the miner's own integrations
(Telegram, Discord, …). The README documents setting them up by hand in
`run.py`. They only see the miner's `Events`, never the app's own events
(crashes, restarts, login expiry, drops completion, updates), and they
cannot act on anything.

## Goal

Two phases. Each can ship on its own.

**Phase 1: pipeline, inbox and Web Push**

1. One backend **notification pipeline**. Every source publishes typed
   notifications into it, and it fans them out to destinations.
2. An **in-app inbox**: a bell in the header with an unread count, and a
   drawer listing recent notifications.
3. **Web Push** to any browser that opts in. It keeps working after the
   tab is closed. Each device has its own preferences, and Chrome/Edge
   get a **Cancel restart** button.

**Phase 2: ntfy and Telegram**

4. **ntfy** and **Telegram** as destinations that work without the
   browser. Credentials come from env vars only, and preferences are set
   in the UI like a device's.

Constraints the user has set:

- **Opt-in.** No destination sends anything until the user turns it on.
  A browser is off until it subscribes. ntfy and Telegram are off until
  their env vars are set.
- **Per-device preferences.** Every destination (each browser, ntfy,
  Telegram) chooses its own event kinds, streamer filter and quiet hours.
- **HTTPS is acceptable** for Web Push. The README's reverse-proxy
  section already covers it, and `localhost` works without it.

## Web Push, briefly

A page registers a service worker and calls `pushManager.subscribe()`
with the server's VAPID public key. The browser returns a subscription:
an endpoint URL at the vendor's push service (FCM, Mozilla autopush,
Apple) plus two encryption keys. The backend stores it. To notify, the
backend encrypts a payload for those keys (RFC 8291), signs a JWT with
its VAPID private key (RFC 8292), and POSTs to the endpoint. The vendor
wakes the service worker, which shows the notification. No tab has to be
open, and the vendor never sees the plaintext.

What follows from that, and what this design is built around:

- **Secure context only.** Service workers and `PushManager` exist only
  over HTTPS or on `localhost`. On `http://192.168.x.x` the UI explains
  why and links to the README's reverse-proxy section. It hides nothing
  else.
- **The browser process must be running.** Desktop Chrome can run in the
  background, and Firefox has to be open. Android wakes the browser by
  itself.
- **iOS/iPadOS 16.4+ only for a Home Screen install.** This needs a web
  app manifest, which the app does not have yet. The UI detects iOS
  outside standalone mode and says "Add to Home Screen first".
- **Action buttons are Chromium-only.** Chrome and Edge (desktop and
  Android) show up to two buttons. Firefox and Safari show none. There,
  a click opens the app on the relevant screen, which for a restart
  already carries the banner with Cancel.
- **Every push must show a notification.** Safari revokes subscriptions
  that receive silent pushes, and Chrome shows a generic "updated in the
  background" notice. The service worker therefore always calls
  `showNotification`.
- **The backend needs outbound internet** to reach the push services. It
  already has it for the campaign tracker and the update check.

## The event catalogue

Every notification has a **kind**. Kinds are named in one const object
(`NOTIFY_KIND`) for the same reason the app log has `EVENT`: a typo
should be a compile error. The catalogue gives each kind a group, a
label, a one-line description, a default, a delivery urgency, a TTL, and
whether it goes in the inbox. The frontend reads the catalogue from the
API rather than hard-coding labels.

"Default" is what a destination gets for a kind it has never toggled. A
destination that is off sends nothing, whatever its defaults say.

### Miner health

| Kind | Default | Inbox | Source | Notes |
|---|---|---|---|---|
| `miner.crashed` | on | yes | Supervisor: an unintended exit | Body says what happens next: "restarting in 8s (crash 2 of 5 this hour)", "gave up after 6 crashes", or "exited immediately; config or environment is broken". Tag `miner-health`, so a crash loop replaces one notification instead of stacking five. |
| `miner.recovered` | off | yes | Supervisor: `RUNNING` after a crash | Same tag, so it replaces the crash notice. |
| `twitch.signedOut` | on | yes | `LoginStatus`: logged in → logged out (an `AUTH` error) | Opens the Twitch account screen. Fires on the transition only, never at boot for a session that was already dead. |
| `restart.pending` | on | yes | `PendingRestart` | Actionable. See "Cancelling a restart". Follow-ups (cancelled, fired) reuse the kind and the tag. |
| `app.update` | on | yes | `UpdateChecker` finds a newer release | Once per version, deduped across backend restarts. |

### Drops

| Kind | Default | Inbox | Source | Notes |
|---|---|---|---|---|
| `drop.claimed` | on | yes | Doorbell `DROP_CLAIM` | Body is the miner's own message. Batched. |
| `campaign.completed` | on | yes | Campaign watcher | Any campaign with progress that turns fully collected, subscribed or not. Once per campaign. |
| `campaign.endingSoon` | on | yes | Campaign watcher | A campaign with partial progress whose `endsAt` is within 24 hours. Once per campaign. |
| `campaign.started` | off | yes | Engine: `SUBSCRIPTION_OPENED`, `QUEUE_STARTED` | A scheduled subscription opened, or the queue moved on. |
| `campaign.new` | off | yes | Campaign watcher | A campaign appears in the catalogue for a game the user has a **game subscription** for. Once per campaign. |

### Streamers

| Kind | Default | Inbox | Source | Notes |
|---|---|---|---|---|
| `streamer.online` | off | no | State pass | Filtered by the destination's streamer list. Batched. See "Streamer transitions". |
| `streamer.offline` | off | no | State pass | Same filter. |

### Points and chat

| Kind | Default | Inbox | Source |
|---|---|---|---|
| `prediction.won` | off | no | Doorbell `BET_WIN` |
| `prediction.lost` | off | no | Doorbell `BET_LOSE` |
| `streak.earned` | off | no | Doorbell `GAIN_FOR_WATCH_STREAK` |
| `raid.joined` | off | no | Doorbell `JOIN_RAID` |
| `chat.mention` | off | yes | Doorbell `CHAT_MENTION` |
| `gift.received` | on | yes | Doorbell `GIFT_SUB_RECEIVED` |

Kinds with "Inbox: no" are high-volume. The dashboard's activity feed
already lists every one of them, so the inbox stays readable.

### Digest

| Kind | Default | Inbox | Source |
|---|---|---|---|
| `digest.daily` | off | no | Scheduler, at the destination's `digestAt` |

Yesterday in one line per figure: points earned (`daily_points`), drops
claimed (`events`), hours mined (`miner_sessions`) and the top streamer.
It uses the same queries as the Insights recap, over one day. It is sent
only if something happened.

## Architecture

```
 sources                          pipeline                     destinations
 ───────                          ────────                     ────────────
 Supervisor ──────┐
 LoginStatus ─────┤
 PendingRestart ──┤
 SubscriptionEngine ┤             ┌─ inbox (SQLite) ─→ SSE "notification"
 StateService ────┼─→ Notifier ──┤
 doorbell route ──┤   .publish()  └─ for each destination:
 UpdateChecker ───┤                  wants(kind)? streamer? quiet hours?
 CampaignWatcher ─┤                    → batcher → channel.send()
 DigestScheduler ─┘                                  ├─ WebPushChannel
                                                     ├─ NtfyChannel     (phase 2)
                                                     └─ TelegramChannel (phase 2)
```

Sources call `notifier.publish()` directly with a typed notification.
The pipeline does **not** scrape the app log: the app log can be
switched off (`APP_LOG_LEVEL`), and notifications must not go quiet with
it. The call sites are mostly next to an existing `log.*` call, which
already marks the moment.

### Module layout

New directory `apps/backend/src/notify/`:

| File | Purpose |
|---|---|
| `catalogue.ts` | `NOTIFY_KIND`, the catalogue table and the `Notification` type. |
| `prefs.ts` | The prefs schema (zod) and `wants(prefs, notification, now)`: kind default, streamer filter, quiet hours. Pure. |
| `notifier.ts` | `Notifier`: `publish()`, inbox write, SSE broadcast, fan-out, batching. |
| `batcher.ts` | Per destination and kind, collects bursts into a single summary. Pure over an injected clock. |
| `store.ts` | SQLite access: destinations, inbox and dedupe keys. |
| `actions.ts` | Mints and redeems action tokens. |
| `channels/webPush.ts` | VAPID keys and `send()` via `web-push`. Maps push-service status codes. |
| `channels/ntfy.ts` | Phase 2. |
| `channels/telegram.ts` | Phase 2. Includes the callback poller. |
| `watchers/streams.ts` | Online/offline transitions from the state pass. |
| `watchers/campaigns.ts` | `CampaignWatcher`: completed, ending soon, new. |
| `watchers/digest.ts` | `DigestScheduler`. |

`web-push` is CommonJS. Import it by default import (`import webpush
from "web-push"`), not by named imports, and check it by running `dist/`
under plain Node. Vitest hides that mistake.

### The notification

```ts
interface Notification {
  kind: NotifyKind;
  title: string;          // "Drop claimed"
  body: string;           // one or two short lines
  ts: number;
  streamer?: string;      // login, for the streamer filter
  link: string;           // deep link, e.g. "/?open=drops&campaign=abc"
  tag?: string;           // replaces an earlier notification with the same tag
  dedupeKey?: string;     // persisted; publish() drops a repeat
  actions?: NotifyAction[];
}
```

`publish()` is synchronous and never throws. Delivery is fire-and-forget
behind it, so a source never waits on a push service.

### Streamer transitions

`History.openStreamerSession` is an upsert on Twitch's stream id. It
returns whether it inserted a row (`changes === 1`), and a new row is a
new stream. That makes online notifications survive restarts: a miner or
backend restart mid-stream finds the existing row and stays quiet.

A new row alone is not enough. After backend downtime, a stream that
started three hours ago is also a new row. `streamer.online` fires only
when the stream's `start_ts` is within 30 minutes of now.

`streamer.offline` fires on an in-process transition only: live on the
previous pass and not on this one. A backend that boots never announces
streams that ended while it was down.

### Campaign watcher

It runs every 15 minutes, but only while some destination wants
`campaign.completed`, `campaign.endingSoon` or `campaign.new`. Otherwise
it costs nothing. It reads `catalogue.get()` and `inventory.get()` (both
cached) and resolves campaigns with `resolveCampaign`.

- **Completed**: `complete` is true, and the campaign had progress, so
  a campaign the user never touched does not count as "completed".
- **Ending soon**: status `partial`, and `endsAt - now` is under 24 hours.
- **New**: the campaign id was not in the previous catalogue, and its
  game id matches a game subscription. The first pass after boot only
  records a baseline.

Each fires at most once per campaign, via `dedupeKey`
(`campaign.completed:<id>` and so on), stored in `notify_seen`. The
engine's own `SUBSCRIPTION_COMPLETED` needs no separate hook: the
watcher covers subscribed campaigns too, and the dedupe key stops a
double send.

### Batching

`streamer.online` and `drop.claimed` are batchable. The first
notification for a destination and kind opens a 10-second window. If
only that one arrives, it is sent unchanged. If more arrive, one summary
is sent instead: "4 streamers went live: alpha, beta, gamma and 1 more".
Other kinds are sent immediately.

### Quiet hours

`prefs.quietHours = { from: "22:00", to: "07:00", allowHealth: boolean }`
is evaluated in the destination's own IANA time zone, which the browser
reports at registration. ntfy and Telegram default to the server's `TZ`.
A window can cross midnight. During quiet hours a notification is
dropped for that destination (the inbox still has it), except the
**Miner health** group when `allowHealth` is set. Nothing is held and
delivered later.

## Storage

Three tables in `history.db`, created in `openDb` like the rest:

```sql
-- One row per place notifications can go. Web Push devices get a
-- random id. ntfy and Telegram are singleton rows ('ntfy', 'telegram'),
-- created when their env vars are first seen. Credentials never live
-- here: prefs are not secrets, tokens are.
CREATE TABLE IF NOT EXISTS notify_destinations (
  id            TEXT PRIMARY KEY,
  channel       TEXT    NOT NULL,          -- 'webpush' | 'ntfy' | 'telegram'
  label         TEXT    NOT NULL,          -- "Chrome on Android", editable
  endpoint      TEXT    UNIQUE,            -- webpush only; upsert and self-match
  subscription  TEXT,                      -- webpush only; PushSubscription JSON
  prefs         TEXT    NOT NULL,          -- JSON, see below
  enabled       INTEGER NOT NULL,          -- 0 = paused; nothing is sent
  created_ts    INTEGER NOT NULL,
  last_ok_ts    INTEGER,
  last_error    TEXT,
  last_error_ts INTEGER
);

-- The inbox. Only kinds whose catalogue entry says inbox.
CREATE TABLE IF NOT EXISTS notifications (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  title    TEXT    NOT NULL,
  body     TEXT    NOT NULL,
  streamer TEXT,
  link     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications (ts);

-- "Already told them" keys that must survive a restart:
-- 'app.update:1.4.0', 'campaign.completed:<id>', ...
CREATE TABLE IF NOT EXISTS notify_seen (
  key TEXT PRIMARY KEY,
  ts  INTEGER NOT NULL
);
```

The daily housekeeping pass prunes the inbox after 30 days and
`notify_seen` after 90.

Prefs, validated with zod on the way in:

```ts
interface Prefs {
  /** Absent kind → catalogue default. */
  kinds: Partial<Record<NotifyKind, boolean>>;
  /** For streamer.online / streamer.offline. */
  streamers: "all" | string[];
  quietHours: { from: string; to: string; allowHealth: boolean } | null;
  /** IANA zone for quietHours and digestAt. */
  timeZone: string;
  digestAt: string;        // "09:00"
}
```

**VAPID keys** are generated on first boot and written to
`$DATA_DIR/vapid.json` (mode 0600). The subject defaults to the repo's
URL. Apple's push service rejects a `mailto:` at `localhost`.
`VAPID_SUBJECT` overrides it. If the file is deleted, every stored
subscription becomes useless. The frontend heals this on its next visit
(see "Self-healing").

## Cancelling a restart

`PendingRestart.request()` publishes `restart.pending`:

> **Miner restarts at 14:32**
> Channels for "Rust Drops" changed. Cancel to keep watching the current ones.
> [Cancel restart] [Open]

- **Tag `restart`**, `requireInteraction: true`, urgency `high`, TTL 90
  seconds: a push delivered after the restart is useless. The body shows
  the fire time, not a countdown, because delivery time varies.
- **Follow-ups** reuse the tag, so the notification is replaced on the
  device: "Restart cancelled" (by anyone, from anywhere), or "Miner
  restarted". They go only to destinations that received the pending
  one.
- **A longer window when someone will be told.** `RESTART_DEFERRAL_MS`
  stays 60 seconds when nobody is notified. When at least one enabled
  destination wants `restart.pending` and is outside quiet hours, the
  deferral is 3 minutes: a phone in a pocket needs longer than 60
  seconds. `PendingRestart` gains a `deferralMs: () => number`
  dependency. The banner reads `dueAt` and needs no change.
- Cancelling keeps its current meaning, "not right now". The engine's
  next pass (15 minutes) proposes again if the difference remains, and
  that is a new notification.

### Action tokens

The Cancel button must work without a session: sessions last 24 hours,
and a service worker cannot log in. Each `restart.pending` therefore
mints one **action token**:

- 32 random bytes, hex. It is held in memory only, bound to that pending
  restart, and expires at its `dueAt`. A backend restart cancels the
  pending restart anyway.
- Redeemed at `POST /api/notify/actions/:token`, which is added to
  `PUBLIC_ENDPOINTS`. It is single-use and can only cancel the restart
  it was minted for. An unknown, used or expired token gets 404 and
  changes nothing.
- It is logged as `USER_RESTART_CANCELLED` with `via: "notification"`
  and the destination's label.

For Web Push the token travels inside the encrypted payload. ntfy and
Telegram are covered in phase 2.

## Deep links

Notification clicks open `link`. The app currently keeps the screen in
React state with no URL, so it gains a small parser:

- `/?open=<screen>&<param>=<value>` → a `ScreenIntent` (e.g.
  `open=drops&campaign=<id>`, `open=dashboard&streamer=<login>`,
  `open=account`). It is read once on boot and then removed with
  `history.replaceState`. If the password gate is up, the intent is
  applied after unlock.
- The service worker's `notificationclick` focuses an open window and
  posts `{ type: "navigate", link }`, which the app feeds through the
  same parser. With no window open, it calls `clients.openWindow(link)`.

## Frontend

### Service worker

The source is `apps/frontend/src/sw/`. It is built by a second small
Vite config (`vite.sw.config.ts`) as a classic script emitted at
`dist/sw.js`, unhashed, and chained into `pnpm build`. `pnpm dev`
watches it. The backend serves `/sw.js` with `Cache-Control: no-cache`
so an update is picked up.

Handlers are plain functions over an injected `self`, so vitest can test
them:

- `push`: parse the payload, then `showNotification(title, { body, tag,
  data, actions, icon, badge, timestamp, requireInteraction, renotify })`.
  This is unconditional (see "Every push must show a notification").
- `notificationclick`: for `cancel-restart`, `fetch` the action URL,
  then show "Restart cancelled", or "Couldn't cancel. Open the app" on
  failure. Otherwise, focus or open the app (see "Deep links").

### Manifest and icons

`public/manifest.webmanifest` (name, `display: "standalone"`, theme
colour, start URL `/`). 192 px, 512 px and maskable PNG icons are
generated from `miner-logo.png`. `index.html` gains `<link
rel="manifest">`, `theme-color` and `apple-touch-icon`. This is required
for iOS push, and makes the app installable everywhere.

### Push helper (`lib/push.ts`)

- `support()` returns one of `ok`, `insecure`, `ios-install`,
  `unsupported` or `denied`. It checks `isSecureContext`,
  `serviceWorker`, `PushManager`, `Notification.permission`, and iOS
  outside standalone mode.
- `enable(label)` must run from the click handler: iOS and Firefox
  require a user gesture. It registers the worker, requests permission,
  subscribes with the VAPID key and POSTs the subscription with
  `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- `disable()`: unsubscribe locally, then remove the server row.
- **Self-healing**, on every app start where permission is granted: if
  the browser's subscription is missing, belongs to an old VAPID key, or
  is unknown to the server, re-subscribe and upsert. Prefs are kept,
  matched by the old endpoint. This covers a deleted `vapid.json`, a
  rotated subscription (`pushsubscriptionchange` is unreliable across
  browsers), and a restored backup.

"Which device is this?" is answered by matching the local subscription's
endpoint against the server's list. No local id is stored.

### Notifications screen

A new sidebar screen, **Notifications**. It is too large for a section
of Settings. It gets a command-palette entry automatically through
`SCREENS`.

1. **This browser**: a card that is off by default. Its states:
   - Unsupported: an explanation plus a README link for `insecure`, and
     "Add to Home Screen" for `ios-install`.
   - Blocked: `denied`, with "allow it in the site settings".
   - Off: **Turn on notifications**.
   - On: label (editable), **Pause**, **Send test**, **Turn off**.
2. **Preferences** for the selected destination: the catalogue grouped
   as above, one switch per kind, with defaults shown. Also a streamer
   picker (all, or chosen from the roster) under the Streamers group,
   quiet hours with "Let miner problems through", and the digest time.
3. **Other destinations**: every other browser, plus ntfy and Telegram
   when configured. Each shows its label, last delivery or last error,
   and can be selected to edit its preferences, sent a test, paused or
   removed (browsers only).
4. When ntfy or Telegram is not configured: one line saying which env
   vars enable it, linking to the README.

Edits save on change (`PUT`), like the other live settings. There is no
staged apply, because none of this touches the miner.

### Inbox

- A **bell** in the header, next to the status badge, with an unread
  badge. Unread means ids newer than `lastSeenId`, which is kept in
  `localStorage` per browser. It is present whether or not push is on:
  the inbox is a passive history like the Logs page and interrupts
  nobody.
- Clicking it opens a **drawer** listing inbox rows newest first, with
  **Load more**. Opening the drawer marks everything seen. Clicking a row
  follows its `link`.
- New rows arrive over SSE as `notification`, in the `/api/notify/inbox`
  row shape.

## API

Everything is behind the session except the action endpoint.

| Route | Purpose |
|---|---|
| `GET /api/notify/config` | VAPID public key, the catalogue, and which channels are configured (`ntfy: { configured, target: "ntfy.sh/…" }`; never a token). |
| `GET /api/notify/destinations` | All destinations with prefs and delivery status. |
| `POST /api/notify/destinations` | `{ subscription, label, timeZone }`. Upsert by endpoint (`previousEndpoint` optional, for self-healing). |
| `PUT /api/notify/destinations/:id` | `{ label?, enabled?, prefs? }`. |
| `POST /api/notify/destinations/:id/remove` | Web Push rows only. |
| `POST /api/notify/destinations/:id/test` | Sends "Test notification", returns the channel's result. |
| `GET /api/notify/inbox?before=<id>&limit=50` | Inbox page. |
| `POST /api/notify/actions/:token` | **Public.** See "Action tokens". |

## Delivery and failure

`WebPushChannel.send` maps the push service's answer:

| Response | Meaning | Action |
|---|---|---|
| 201 | Accepted | Record `last_ok_ts`. |
| 404, 410 | Subscription gone | Delete the row; log `NOTIFY_DEVICE_EXPIRED`. |
| 413 | Payload too large | A bug: bodies are capped at 1 KB before sending. Log it. |
| 429, 5xx | Try later | One retry after `Retry-After` or 30 s; then record `last_error`. |
| Network error | Unreachable | The same single retry. |

TTL and urgency come from the catalogue: `restart.pending` 90 s / high,
health 1 h / high, drops 24 h / normal, points 1 h / low. A `Topic`
header equal to the tag lets the push service drop an undelivered
"pending" once "cancelled" replaces it.

New app log entries under a new `COMPONENT.NOTIFY`:
`NOTIFY_DESTINATION_ADDED` and `NOTIFY_DESTINATION_REMOVED` (user),
`NOTIFY_DEVICE_EXPIRED`, `NOTIFY_FAILED` (warn, per destination, carrying
the status), `NOTIFY_CHANNEL_CONFIGURED` (boot, per phase 2 channel).
Successful sends are debug only, following the rule at the top of
`appLog/types.ts`.

## Phase 2: ntfy and Telegram

### Shared

- Configuration is by env var only. The API reports `configured` and a
  redacted target, never a token. This keeps the rule behind the manual
  integrations (credentials stay out of a UI that may be on plain
  HTTP), while making every non-secret part usable.
- Setting the env vars is the opt-in. The singleton destination row is
  created on first sight, enabled, with catalogue defaults, and the UI
  can pause or tune it like a device. Removing the env vars disables the
  row but keeps its prefs.
- A new **`PUBLIC_URL`** (e.g. `https://miner.home.example`) is the base
  for links and action URLs sent through a third party. Without it,
  ntfy and Telegram messages carry no Open link and no Cancel button.
  Web Push does not need it: its links are relative to the service
  worker's origin.

### ntfy

Env: `NTFY_URL` (server and topic, e.g. `https://ntfy.sh/tmc-8f3k…`),
`NTFY_TOKEN` (optional access token).

- Published as JSON (`POST` to the server root with `topic`) rather than
  with headers, because titles contain non-ASCII streamer and game
  names.
- Mapping: `title`, `message`, `priority` (urgency high → 5 for
  `restart.pending`, 4 for health; normal → 3; low → 2), `tags` (an
  emoji per group), `click` = `PUBLIC_URL + link`.
- `restart.pending` adds `actions: [{ action: "http", label: "Cancel
  restart", url: PUBLIC_URL + "/api/notify/actions/<token>", method:
  "POST", clear: true }]`. The ntfy app on the phone makes that request,
  so the phone must be able to reach `PUBLIC_URL` (LAN, VPN or proxy).
- ntfy cannot replace a delivered message, so follow-ups are new, short
  messages.
- README warning: an ntfy.sh topic is readable by anyone who knows its
  name, and messages include streamer names and the one-shot action
  token. Use an unguessable topic, or a self-hosted server with access
  control.

### Telegram

Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. This can be the same bot
the miner's own integration uses: the miner only calls `sendMessage`,
so nothing competes for its updates.

- `sendMessage` with HTML parse mode (all text escaped).
- `restart.pending` adds an inline keyboard: **Cancel restart**
  (`callback_data: "cancel:<restartId>"`), plus an **Open** URL button
  when `PUBLIC_URL` is set.
- **Polling for button presses**: while a pending restart is
  outstanding, the channel long-polls `getUpdates`. This needs no
  inbound reachability, so Cancel works from anywhere, even without
  `PUBLIC_URL`. The poller stops once the restart resolves, so the bot
  is not polled the rest of the time.
- A callback is honoured only when `callback_query.message.chat.id`
  equals `TELEGRAM_CHAT_ID` and the restart id is the current one. In a
  group chat, any member can press it. The README says so.
- Resolution edits the original message ("Restart cancelled" / "Miner
  restarted"), removes the keyboard, and calls `answerCallbackQuery`.
  Unlike ntfy, Telegram can replace a message.
- If `getUpdates` answers 409 (the bot has a webhook set elsewhere), log
  once and send without buttons.

### Not in phase 2

Discord, Matrix, Gotify, Pushover and webhooks stay with the miner's
own integrations, set up by hand as the README documents. They keep
working unchanged alongside this.

## Build order

1. Pipeline core: catalogue, prefs, notifier, batcher, store, and the
   inbox table with its route and SSE event. This is testable with a
   fake channel.
2. Sources: supervisor, login, doorbell kinds, pending restart (with the
   variable deferral), update checker, streamer transitions, campaign
   watcher, digest.
3. Web Push channel, VAPID keys, destination routes and action tokens.
4. Frontend: manifest and icons, service worker and its build, `lib/push.ts`,
   deep links.
5. Frontend: Notifications screen, bell and drawer.
6. README: the Notifications section rewritten (inbox, Web Push and
   HTTPS, iOS install), with the manual miner integrations kept as
   "Other services". `.env.example`: `VAPID_SUBJECT`.
7. Phase 2: `PUBLIC_URL`, the ntfy channel, the Telegram channel and
   poller, then the README and `.env.example`.

## Testing

Backend (vitest, injected clocks and fake channels):

- `wants()`: catalogue defaults for untouched kinds; explicit toggles;
  the streamer filter; quiet hours inside, outside and across midnight
  in a non-server time zone; `allowHealth`.
- Batcher: a single item passes through unchanged after the window;
  several collapse into one summary; windows are per destination and
  kind.
- Notifier: inbox rows only for inbox kinds; a `dedupeKey` repeat
  dropped, including after a store reopen; one failing destination does
  not block others; `publish()` never throws.
- Streamer transitions: a new row with a fresh start fires; a new row
  with a stale start does not; the same stream after a restart does not;
  offline only on an in-process transition.
- Campaign watcher: complete with prior progress fires once; an untouched
  campaign never "completes"; ending soon only for `partial`; new only
  for subscribed games and never on the baseline pass; idle when no
  destination wants any of its kinds.
- Supervisor, login and update sources: the transitions above, with no
  notification at boot for an already-dead session.
- Pending restart: 60 s with no listener, 3 min with one; follow-ups go
  only to the destinations that received the pending one.
- Action tokens: redeem cancels; a second redeem is 404; expired is 404;
  a token from a superseded restart cannot cancel the new one.
- Web Push channel with an injected `send`: status mapping; a 410
  deletes the row; one retry on 5xx.
- Routes via `app.inject`, in the `server.test.ts` style: prefs
  validation, upsert by endpoint and `previousEndpoint`, no token ever in
  `/api/notify/config`, the action route reachable without a session and
  nothing else newly public.
- Phase 2: ntfy JSON body and priority mapping; actions only with
  `PUBLIC_URL`; Telegram escaping, keyboard shape, callback chat
  check, poller lifecycle, and the 409 fallback. HTTP is faked.
- `dist/` started under plain Node once, to catch the `web-push` CJS
  import.

Frontend:

- `lib/push.ts` with `navigator.serviceWorker`, `PushManager` and
  `Notification` mocked: each `support()` state; `enable()` posts the
  subscription and time zone; self-healing re-subscribes on a key
  mismatch.
- Notifications screen: each "This browser" state; toggles `PUT` the
  right prefs; other destinations listed; the phase 2 hint when
  unconfigured. Mantine overlay options are queried with
  `{ hidden: true }`.
- Bell: unread count from `lastSeenId`, SSE increments, drawer marks
  seen, row click navigates.
- Deep link parser and the post-unlock intent.
- Service worker handlers against a fake `self`: always shows a
  notification; Cancel fetches the token URL and replaces the
  notification; click focuses an existing client or opens one.

Manual: Playwright's Chromium in the container has no Google API keys,
so a real push subscription fails there. It can drive the permission and
UI flow with `pushManager` stubbed. End-to-end delivery (desktop Chrome,
Android Chrome, Firefox, an iOS Home Screen install) is checked on real
devices behind the HTTPS proxy.

## Out of scope

- **Email, Discord, Matrix, Gotify, Pushover, webhooks and Apprise from
  the app.** The miner's own integrations cover these by hand.
- **In-app toasts.** An open tab already gets the OS notification, and
  a toast on top would be a duplicate.
- **Holding notifications through quiet hours** and delivering them
  after. The inbox already keeps them.
- **"Drop can't progress" (sub-only or preconditions).** Detection needs
  the tracker's unreliable `requiresSub` fields; see the drops spec.
- **Per-user accounts.** Destinations belong to the one shared password,
  like everything else.
- **Actions other than Cancel restart** (e.g. Restart now, Start miner).
  The token mechanism supports more, but each is a new capability
  reachable without a session and deserves its own decision.
