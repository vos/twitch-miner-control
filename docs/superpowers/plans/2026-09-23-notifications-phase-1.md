# Notifications Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One backend notification pipeline, an in-app inbox (a bell and a drawer), and opt-in Web Push with per-device preferences, including a Cancel restart action that works without a session.

**Architecture:** Sources (supervisor, login status, pending restart, drops engine, state pass, doorbell, update checker, campaign watcher, digest scheduler) call `notifier.publish()` with a typed `Notification`. The `Notifier` writes inbox kinds to SQLite and pushes them over SSE. It then fans out to every enabled destination whose preferences want the kind, batching bursty kinds, and delivers through a `Channel`. Phase 1 has one channel, `WebPushChannel`, built on the `web-push` package with VAPID keys kept in `$DATA_DIR/vapid.json`. The frontend adds a web app manifest, a service worker built as its own classic script, a push helper that subscribes and heals subscriptions, deep links, a Notifications screen, and a header bell.

**Tech Stack:** Fastify 5, better-sqlite3, zod 4, `web-push` 3.6 (new, CommonJS), Vitest (backend). React 19, Mantine 9.6 (`Drawer`, `Indicator`, `Switch`, `SegmentedControl`, `MultiSelect`), Vite 8 with a second library-mode config for the service worker, Vitest with jsdom (frontend).

**Spec:** `docs/superpowers/specs/2026-09-23-notifications-design.md`. This plan covers Phase 1 (goals 1–3, build order steps 1–6). Phase 2 (ntfy, Telegram, `PUBLIC_URL`) is out of scope. The `channel` column still exists so Phase 2 can add rows.

## Global Constraints

- **Never commit without the user's go-ahead.** At the end of each task, show the diffstat and wait, unless the user has picked a commit rhythm for this run. Commit on `main` with no branch. Use conventional-commit subjects with an explanatory body, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push unless asked.
- **Comments describe the current code.** Don't narrate rejected alternatives, but keep any note that stops a future change from breaking something.
- **Opt-in.** A browser sends nothing until it subscribes. Unset kinds follow `defaultOn` from the catalogue.
- **Per-destination preferences:** event kinds, streamer filter, quiet hours (in the destination's own IANA time zone) with "let miner problems through", and the digest time.
- **Every push shows a notification.** The service worker calls `showNotification` for every push, including one it cannot parse. Safari revokes subscriptions that receive silent pushes.
- **`web-push` is CommonJS.** Import it by default import only (`import webpush from "web-push"`), and run `dist/` under plain Node once (Task 13). Vitest does not catch a named-import mistake.
- **Tests run in the container's Europe/Berlin zone.** Quiet-hours and digest tests pass explicit time zones and UTC instants built with `Date.UTC`, so they do not depend on the machine's zone.
- **Mantine overlay content** (Select and MultiSelect options, Drawer contents while animating) is queried with `{ hidden: true }` where needed.
- **Departures from the spec:**
  - The action endpoint is `POST /api/notify/action` with body `{ token }`, not `/api/notify/actions/:token`. The auth allowlist matches literal paths only (`isPublic` in `http/auth.ts` compares the raw path with the route pattern), so a parametric route could never be public.
  - The restart notification's title is rendered on the device from `dueAt` ("Miner restarts at 14:32" in the device's own time). The server-side title stored in the inbox is "Miner restart pending".
  - Source modules live in `apps/backend/src/notify/sources/` (health, restart, streams, doorbell, campaigns, digest), not in `watchers/`.
  - The service worker is built into `apps/frontend/public/sw.js` (gitignored), so the Vite dev server serves it too. `predev` and `build` build it first.
  - `campaign.completed` stays silent on the watcher's first-ever run: it marks existing completions as seen through a persisted `campaign.watch.primed` key, so turning the kind on does not announce a backlog.
  - A browser whose endpoint the server no longer knows, while its VAPID key still matches, was removed from another device. It unsubscribes itself instead of re-registering.
  - A `test` kind exists for "Send test". It is not listed in the preferences UI.
- **Commands:**
  - Backend tests: `pnpm --filter @app/backend exec vitest run <path>`
  - Frontend tests: `pnpm --filter @app/frontend exec vitest run <path>`
  - Frontend typecheck: `pnpm --filter @app/frontend exec tsc -b`
  - Backend build: `pnpm run build:backend`
  - Full test run: `pnpm test`
- `verbatimModuleSyntax` is on, so type-only imports use `import type`.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `apps/backend/src/notify/catalogue.ts` | create | `NOTIFY_KIND`, `CATALOGUE`, `GROUPS`, `Notification` |
| `apps/backend/src/notify/prefs.ts` | create | Prefs schema, `localClock`, quiet hours, `wants`/`wantsKind` |
| `apps/backend/src/notify/store.ts` | create | Destinations, inbox, dedupe keys (SQLite) |
| `apps/backend/src/db/schema.ts` | modify | Three new tables |
| `apps/backend/src/notify/batcher.ts` | create | `Batcher`, `combine` |
| `apps/backend/src/notify/notifier.ts` | create | `Notifier`, `Channel`, `SendResult` |
| `apps/backend/src/appLog/types.ts` | modify | `COMPONENT.NOTIFY`, four `NOTIFY_*` events |
| `apps/backend/src/notify/actions.ts` | create | `ActionTokens` |
| `apps/backend/src/notify/channels/webPush.ts` | create | VAPID keys, payload, `WebPushChannel` |
| `apps/backend/src/notify/routes.ts` | create | `/api/notify/*` routes |
| `apps/backend/src/http/server.ts`, `http/auth.ts` | modify | Mount routes, SSE `notification`, public action route, `sw.js` cache header |
| `apps/backend/src/miner/supervisor.ts` | modify | `"crash"` event carrying `CrashInfo` |
| `apps/backend/src/helpers/loginStatus.ts` | modify | `onSignedOut` |
| `apps/backend/src/config/updateCheck.ts` | modify | `onAvailable` |
| `apps/backend/src/notify/sources/health.ts` | create | Crash, recovery, sign-out, update |
| `apps/backend/src/drops/pendingRestart.ts` | modify | `deferralMs`, `onTransition`, `cancel(via)` |
| `apps/backend/src/notify/sources/restart.ts` | create | `RestartNotifications` |
| `apps/backend/src/db/history.ts`, `state/service.ts` | modify | `openStreamerSession` returns `boolean`; `"streams"` event |
| `apps/backend/src/notify/sources/streams.ts`, `sources/doorbell.ts` | create | Online/offline; miner events |
| `apps/backend/src/drops/engine.ts` | modify | `onCampaignStarted` |
| `apps/backend/src/notify/sources/campaigns.ts` | create | `CampaignWatcher`, `campaignStartedNotification` |
| `apps/backend/src/insights/recap.ts` | modify | `buildDaySummary` |
| `apps/backend/src/notify/sources/digest.ts` | create | `DigestScheduler` |
| `apps/backend/src/index.ts` | modify | Wiring, housekeeping prune, shutdown |
| `apps/frontend/public/manifest.webmanifest`, `public/icons/*` | create | Installable app, iOS push prerequisite |
| `apps/frontend/src/sw/handlers.ts`, `src/sw/sw.ts` | create | Service worker |
| `apps/frontend/vite.sw.config.ts` | create | Builds `public/sw.js` |
| `apps/frontend/src/api/notify.ts` | create | Types and fetchers |
| `apps/frontend/src/lib/push.ts` | create | Support detection, enable/disable, heal |
| `apps/frontend/src/lib/deepLink.ts` | create | `?open=` parser |
| `apps/frontend/src/app.tsx`, `components/Sidebar.tsx` | modify | Notifications screen, bell, deep links, heal on start |
| `apps/frontend/src/routes/Notifications.tsx` | create | The screen |
| `apps/frontend/src/components/notify/*.tsx` | create | `ThisBrowserCard`, `PrefsEditor`, `DestinationList` |
| `apps/frontend/src/components/NotificationBell.tsx` | create | Bell and inbox drawer |
| `README.md`, `.env.example`, `.gitignore` | modify | Docs, `VAPID_SUBJECT`, `public/sw.js` |

---

### Task 1: Catalogue and preferences

**Files:**
- Create: `apps/backend/src/notify/catalogue.ts`
- Create: `apps/backend/src/notify/catalogue.test.ts`
- Create: `apps/backend/src/notify/prefs.ts`
- Create: `apps/backend/src/notify/prefs.test.ts`

**Interfaces:**
- Produces, from `notify/catalogue.ts`:
  - `NOTIFY_KIND` (const object), `type NotifyKind`, `ALL_KINDS: [NotifyKind, ...NotifyKind[]]`
  - `type NotifyGroup = "health" | "drops" | "streamers" | "points" | "digest"`, `GROUPS: ReadonlyArray<{ id: NotifyGroup; label: string }>`
  - `type Urgency`, `interface KindInfo`, `CATALOGUE: readonly KindInfo[]`, `LISTED: readonly KindInfo[]` (catalogue minus `test`), `kindInfo(kind): KindInfo`
  - `interface NotifyAction { id: "cancel-restart"; title: string; token: string }`
  - `interface Notification`, `type PublishInput = Omit<Notification, "ts"> & { ts?: number }`
- Produces, from `notify/prefs.ts`:
  - `SERVER_TIME_ZONE: string`, `isTimeZone(value: string): boolean`
  - `prefsSchema`, `type Prefs`, `type QuietHours`, `defaultPrefs(timeZone: string): Prefs`
  - `parseHhmm(value: string): number` (minutes since midnight)
  - `localClock(ts: number, timeZone: string): { date: string; minutes: number }`
  - `inQuietHours(quiet: QuietHours | null, timeZone: string, ts: number): boolean`
  - `kindEnabled(prefs: Prefs, kind: NotifyKind): boolean`
  - `wantsKind(prefs: Prefs, kind: NotifyKind, ts: number): boolean`
  - `wants(prefs: Prefs, n: Pick<Notification, "kind" | "streamer">, ts: number): boolean`

- [ ] **Step 1: Write the failing catalogue test**

Create `apps/backend/src/notify/catalogue.test.ts`:

```ts
import { expect, test } from "vitest";
import { ALL_KINDS, CATALOGUE, GROUPS, LISTED, NOTIFY_KIND, kindInfo } from "./catalogue.js";

test("every kind has exactly one catalogue entry", () => {
  expect(CATALOGUE.map((k) => k.kind).sort()).toEqual([...ALL_KINDS].sort());
});

test("every entry belongs to a known group", () => {
  const groups = new Set(GROUPS.map((g) => g.id));
  for (const info of CATALOGUE) expect(groups.has(info.group)).toBe(true);
});

test("the defaults match the spec", () => {
  const on = CATALOGUE.filter((k) => k.defaultOn && k.kind !== NOTIFY_KIND.TEST).map((k) => k.kind);
  expect(on.sort()).toEqual([
    "app.update", "campaign.completed", "campaign.endingSoon", "drop.claimed",
    "gift.received", "miner.crashed", "restart.pending", "twitch.signedOut",
  ]);
});

test("high-volume kinds stay out of the inbox", () => {
  for (const kind of ["streamer.online", "streamer.offline", "prediction.won", "raid.joined"] as const) {
    expect(kindInfo(kind).inbox).toBe(false);
  }
});

test("the test kind is not offered as a preference", () => {
  expect(LISTED.some((k) => k.kind === NOTIFY_KIND.TEST)).toBe(false);
  expect(LISTED).toHaveLength(CATALOGUE.length - 1);
});

test("a restart pending is short-lived and urgent", () => {
  expect(kindInfo(NOTIFY_KIND.RESTART_PENDING)).toMatchObject({ urgency: "high", ttlSeconds: 90 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/catalogue.test.ts`
Expected: FAIL, "Failed to resolve import ./catalogue.js".

- [ ] **Step 3: Implement the catalogue**

Create `apps/backend/src/notify/catalogue.ts`:

```ts
/**
 * Every notification kind, and what each one means to a destination.
 *
 * Named in one const object for the same reason the app log's EVENT is: a
 * misspelt kind would publish something no preference ever matches, which
 * fails silently. Here it is a compile error.
 */
export const NOTIFY_KIND = {
  MINER_CRASHED: "miner.crashed",
  MINER_RECOVERED: "miner.recovered",
  TWITCH_SIGNED_OUT: "twitch.signedOut",
  RESTART_PENDING: "restart.pending",
  APP_UPDATE: "app.update",
  DROP_CLAIMED: "drop.claimed",
  CAMPAIGN_COMPLETED: "campaign.completed",
  CAMPAIGN_ENDING_SOON: "campaign.endingSoon",
  CAMPAIGN_STARTED: "campaign.started",
  CAMPAIGN_NEW: "campaign.new",
  STREAMER_ONLINE: "streamer.online",
  STREAMER_OFFLINE: "streamer.offline",
  PREDICTION_WON: "prediction.won",
  PREDICTION_LOST: "prediction.lost",
  STREAK_EARNED: "streak.earned",
  RAID_JOINED: "raid.joined",
  CHAT_MENTION: "chat.mention",
  GIFT_RECEIVED: "gift.received",
  DIGEST_DAILY: "digest.daily",
  /** "Send test" on the Notifications screen. Never offered as a preference. */
  TEST: "test",
} as const;

export type NotifyKind = (typeof NOTIFY_KIND)[keyof typeof NOTIFY_KIND];

export const ALL_KINDS = Object.values(NOTIFY_KIND) as [NotifyKind, ...NotifyKind[]];

export type NotifyGroup = "health" | "drops" | "streamers" | "points" | "digest";

/** In display order. */
export const GROUPS: ReadonlyArray<{ id: NotifyGroup; label: string }> = [
  { id: "health", label: "Miner health" },
  { id: "drops", label: "Drops" },
  { id: "streamers", label: "Streamers" },
  { id: "points", label: "Points and chat" },
  { id: "digest", label: "Digest" },
];

/** Web Push urgency, RFC 8030 section 5.3. */
export type Urgency = "very-low" | "low" | "normal" | "high";

export interface KindInfo {
  kind: NotifyKind;
  group: NotifyGroup;
  label: string;
  description: string;
  /** What a destination gets for a kind it has never toggled. */
  defaultOn: boolean;
  /** Whether the in-app inbox keeps it. The activity feed already lists the high-volume kinds. */
  inbox: boolean;
  urgency: Urgency;
  /** How long a push service may hold it for a device that is offline. */
  ttlSeconds: number;
  /** Bursts inside the batch window collapse into one summary. */
  batch: boolean;
}

const HOUR_S = 3600;
const DAY_S = 86_400;

export const CATALOGUE: readonly KindInfo[] = [
  { kind: NOTIFY_KIND.MINER_CRASHED, group: "health", label: "Miner crashed",
    description: "The miner exited unexpectedly, or keeps crashing.",
    defaultOn: true, inbox: true, urgency: "high", ttlSeconds: HOUR_S, batch: false },
  { kind: NOTIFY_KIND.MINER_RECOVERED, group: "health", label: "Miner running again",
    description: "The miner came back after a crash.",
    defaultOn: false, inbox: true, urgency: "normal", ttlSeconds: HOUR_S, batch: false },
  { kind: NOTIFY_KIND.TWITCH_SIGNED_OUT, group: "health", label: "Twitch sign-in needed",
    description: "Twitch rejected the stored session.",
    defaultOn: true, inbox: true, urgency: "high", ttlSeconds: HOUR_S, batch: false },
  { kind: NOTIFY_KIND.RESTART_PENDING, group: "health", label: "Restart pending",
    description: "The drops engine wants to restart the miner. Chrome and Edge show a Cancel button.",
    defaultOn: true, inbox: true, urgency: "high", ttlSeconds: 90, batch: false },
  { kind: NOTIFY_KIND.APP_UPDATE, group: "health", label: "Update available",
    description: "A newer release of this app is published.",
    defaultOn: true, inbox: true, urgency: "normal", ttlSeconds: DAY_S, batch: false },
  { kind: NOTIFY_KIND.DROP_CLAIMED, group: "drops", label: "Drop claimed",
    description: "The miner claimed a drop.",
    defaultOn: true, inbox: true, urgency: "normal", ttlSeconds: DAY_S, batch: true },
  { kind: NOTIFY_KIND.CAMPAIGN_COMPLETED, group: "drops", label: "Campaign complete",
    description: "Every drop in a campaign you made progress on is collected.",
    defaultOn: true, inbox: true, urgency: "normal", ttlSeconds: DAY_S, batch: false },
  { kind: NOTIFY_KIND.CAMPAIGN_ENDING_SOON, group: "drops", label: "Campaign ending soon",
    description: "A campaign ends within 24 hours with drops still unclaimed.",
    defaultOn: true, inbox: true, urgency: "normal", ttlSeconds: DAY_S, batch: false },
  { kind: NOTIFY_KIND.CAMPAIGN_STARTED, group: "drops", label: "Campaign started",
    description: "A scheduled or queued subscription started collecting.",
    defaultOn: false, inbox: true, urgency: "normal", ttlSeconds: DAY_S, batch: false },
  { kind: NOTIFY_KIND.CAMPAIGN_NEW, group: "drops", label: "New campaign",
    description: "A campaign appeared for a game you subscribe to.",
    defaultOn: false, inbox: true, urgency: "normal", ttlSeconds: DAY_S, batch: false },
  { kind: NOTIFY_KIND.STREAMER_ONLINE, group: "streamers", label: "Streamer online",
    description: "A streamer went live.",
    defaultOn: false, inbox: false, urgency: "normal", ttlSeconds: HOUR_S, batch: true },
  { kind: NOTIFY_KIND.STREAMER_OFFLINE, group: "streamers", label: "Streamer offline",
    description: "A streamer ended their stream.",
    defaultOn: false, inbox: false, urgency: "low", ttlSeconds: HOUR_S, batch: false },
  { kind: NOTIFY_KIND.PREDICTION_WON, group: "points", label: "Prediction won",
    description: "A prediction the miner bet on paid out.",
    defaultOn: false, inbox: false, urgency: "low", ttlSeconds: HOUR_S, batch: false },
  { kind: NOTIFY_KIND.PREDICTION_LOST, group: "points", label: "Prediction lost",
    description: "A prediction the miner bet on lost.",
    defaultOn: false, inbox: false, urgency: "low", ttlSeconds: HOUR_S, batch: false },
  { kind: NOTIFY_KIND.STREAK_EARNED, group: "points", label: "Watch streak bonus",
    description: "A watch streak paid its bonus.",
    defaultOn: false, inbox: false, urgency: "low", ttlSeconds: HOUR_S, batch: false },
  { kind: NOTIFY_KIND.RAID_JOINED, group: "points", label: "Raid joined",
    description: "The miner followed a raid.",
    defaultOn: false, inbox: false, urgency: "low", ttlSeconds: HOUR_S, batch: false },
  { kind: NOTIFY_KIND.CHAT_MENTION, group: "points", label: "Chat mention",
    description: "Someone mentioned you in chat.",
    defaultOn: false, inbox: true, urgency: "normal", ttlSeconds: HOUR_S, batch: false },
  { kind: NOTIFY_KIND.GIFT_RECEIVED, group: "points", label: "Gift sub received",
    description: "Someone gifted you a sub.",
    defaultOn: true, inbox: true, urgency: "normal", ttlSeconds: DAY_S, batch: false },
  { kind: NOTIFY_KIND.DIGEST_DAILY, group: "digest", label: "Daily digest",
    description: "Yesterday's points, drops and hours in one notification.",
    defaultOn: false, inbox: false, urgency: "low", ttlSeconds: 12 * HOUR_S, batch: false },
  { kind: NOTIFY_KIND.TEST, group: "health", label: "Test notification",
    description: "Sent by Send test.",
    defaultOn: true, inbox: false, urgency: "normal", ttlSeconds: 300, batch: false },
];

/** What the preferences UI offers. */
export const LISTED: readonly KindInfo[] = CATALOGUE.filter((k) => k.kind !== NOTIFY_KIND.TEST);

const BY_KIND = new Map(CATALOGUE.map((info) => [info.kind, info]));

export function kindInfo(kind: NotifyKind): KindInfo {
  const info = BY_KIND.get(kind);
  if (info === undefined) throw new Error(`no catalogue entry for ${kind}`);
  return info;
}

export interface NotifyAction {
  id: "cancel-restart";
  title: string;
  /** Single-use; see notify/actions.ts. */
  token: string;
}

export interface Notification {
  kind: NotifyKind;
  /** Short: "Drop claimed". */
  title: string;
  /** One or two short lines. */
  body: string;
  ts: number;
  /** For the streamer filter and the batch summary. */
  streamer?: { login: string; name: string };
  /** Deep link: "/?open=drops&campaign=abc", or an absolute URL. */
  link: string;
  /** Replaces an earlier notification with the same tag on the device. */
  tag?: string;
  /** Persisted; a notification with a key already seen is dropped. */
  dedupeKey?: string;
  actions?: NotifyAction[];
  /**
   * Goes only to the destinations that received the latest notification
   * with the same tag, whatever their preferences now say.
   */
  followUp?: boolean;
  /** For restart.pending: when it fires, so the device can show its own local time. */
  dueAt?: number;
}

export type PublishInput = Omit<Notification, "ts"> & { ts?: number };
```

- [ ] **Step 4: Run the catalogue test to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/notify/catalogue.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing prefs test**

Create `apps/backend/src/notify/prefs.test.ts`:

```ts
import { expect, test } from "vitest";
import { NOTIFY_KIND } from "./catalogue.js";
import {
  defaultPrefs, inQuietHours, kindEnabled, localClock, prefsSchema, wants, wantsKind,
  type Prefs,
} from "./prefs.js";

const BERLIN = "Europe/Berlin";
// 2026-09-23 is summer time in Berlin (UTC+2) and New York (UTC-4).
const utc = (hour: number, minute = 0, day = 23) => Date.UTC(2026, 8, day, hour, minute);

const prefs = (over: Partial<Prefs> = {}): Prefs => ({ ...defaultPrefs(BERLIN), ...over });

test("an untouched kind follows the catalogue default", () => {
  expect(kindEnabled(prefs(), NOTIFY_KIND.MINER_CRASHED)).toBe(true);
  expect(kindEnabled(prefs(), NOTIFY_KIND.STREAMER_ONLINE)).toBe(false);
});

test("an explicit toggle beats the default", () => {
  const p = prefs({ kinds: { "miner.crashed": false, "streamer.online": true } });
  expect(kindEnabled(p, NOTIFY_KIND.MINER_CRASHED)).toBe(false);
  expect(kindEnabled(p, NOTIFY_KIND.STREAMER_ONLINE)).toBe(true);
});

test("the local clock is read in the destination's zone", () => {
  expect(localClock(utc(22, 30), BERLIN)).toEqual({ date: "2026-09-24", minutes: 30 });
  expect(localClock(utc(22, 30), "America/New_York")).toEqual({ date: "2026-09-23", minutes: 18 * 60 + 30 });
});

test("quiet hours can cross midnight", () => {
  const q = { from: "22:00", to: "07:00", allowHealth: false };
  expect(inQuietHours(q, BERLIN, utc(21, 30))).toBe(true); // 23:30
  expect(inQuietHours(q, BERLIN, utc(4, 30))).toBe(true); // 06:30
  expect(inQuietHours(q, BERLIN, utc(6, 30))).toBe(false); // 08:30
  expect(inQuietHours(q, "America/New_York", utc(21, 30))).toBe(false); // 17:30
});

test("quiet hours inside one day", () => {
  const q = { from: "13:00", to: "14:00", allowHealth: false };
  expect(inQuietHours(q, BERLIN, utc(11, 30))).toBe(true); // 13:30
  expect(inQuietHours(q, BERLIN, utc(12, 0))).toBe(false); // 14:00, end is exclusive
});

test("equal ends mean no quiet hours at all", () => {
  expect(inQuietHours({ from: "08:00", to: "08:00", allowHealth: false }, BERLIN, utc(6))).toBe(false);
});

test("quiet hours silence everything unless health is let through", () => {
  const night = utc(21, 30);
  const strict = prefs({ quietHours: { from: "22:00", to: "07:00", allowHealth: false } });
  const lenient = prefs({ quietHours: { from: "22:00", to: "07:00", allowHealth: true } });
  expect(wantsKind(strict, NOTIFY_KIND.MINER_CRASHED, night)).toBe(false);
  expect(wantsKind(lenient, NOTIFY_KIND.MINER_CRASHED, night)).toBe(true);
  expect(wantsKind(lenient, NOTIFY_KIND.DROP_CLAIMED, night)).toBe(false);
});

test("the streamer filter applies to the streamers group only", () => {
  const p = prefs({
    kinds: { "streamer.online": true },
    streamers: ["Alpha"],
  });
  const online = (login: string) => ({
    kind: NOTIFY_KIND.STREAMER_ONLINE, streamer: { login, name: login },
  });
  expect(wants(p, online("alpha"), utc(12))).toBe(true);
  expect(wants(p, online("beta"), utc(12))).toBe(false);
  expect(wants(p, { kind: NOTIFY_KIND.STREAMER_ONLINE }, utc(12))).toBe(false);
  expect(wants(p, { kind: NOTIFY_KIND.DROP_CLAIMED }, utc(12))).toBe(true);
});

test("the schema accepts the defaults and rejects nonsense", () => {
  expect(prefsSchema.safeParse(defaultPrefs(BERLIN)).success).toBe(true);
  expect(prefsSchema.safeParse({ ...defaultPrefs(BERLIN), kinds: { nope: true } }).success).toBe(false);
  expect(prefsSchema.safeParse({ ...defaultPrefs(BERLIN), timeZone: "Mars/Olympus" }).success).toBe(false);
  expect(prefsSchema.safeParse({ ...defaultPrefs(BERLIN), digestAt: "24:00" }).success).toBe(false);
});

test("an unknown zone at registration falls back to the server's", () => {
  expect(defaultPrefs("Mars/Olympus").timeZone).toBe(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/prefs.test.ts`
Expected: FAIL, "Failed to resolve import ./prefs.js".

- [ ] **Step 7: Implement prefs**

Create `apps/backend/src/notify/prefs.ts`:

```ts
import { z } from "zod";
import { usernameSchema } from "../config/schema.js";
import { ALL_KINDS, kindInfo, type Notification, type NotifyKind } from "./catalogue.js";

/** The zone this process runs in: `TZ`, or the container default. */
export const SERVER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

export const prefsSchema = z
  .object({
    /** Absent kind: the catalogue default. */
    kinds: z.partialRecord(z.enum(ALL_KINDS), z.boolean()),
    /** For the streamers group only. */
    streamers: z.union([z.literal("all"), z.array(usernameSchema).max(500)]),
    quietHours: z
      .object({ from: hhmm, to: hhmm, allowHealth: z.boolean() })
      .strict()
      .nullable(),
    /** IANA zone that quietHours and digestAt are read in. */
    timeZone: z.string().refine(isTimeZone, "unknown time zone"),
    digestAt: hhmm,
  })
  .strict();

export type Prefs = z.infer<typeof prefsSchema>;
export type QuietHours = NonNullable<Prefs["quietHours"]>;

export function defaultPrefs(timeZone: string): Prefs {
  return {
    kinds: {},
    streamers: "all",
    quietHours: null,
    timeZone: isTimeZone(timeZone) ? timeZone : SERVER_TIME_ZONE,
    digestAt: "09:00",
  };
}

/** Minutes since midnight. The input has already passed `hhmm`. */
export function parseHhmm(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    // en-CA formats the date as YYYY-MM-DD; h23 keeps midnight at "00".
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock date and minute of `ts` in `timeZone`. */
export function localClock(ts: number, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    formatter(timeZone).formatToParts(ts).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** `from` inclusive, `to` exclusive; a window with equal ends is empty. */
export function inQuietHours(quiet: QuietHours | null, timeZone: string, ts: number): boolean {
  if (quiet === null) return false;
  const from = parseHhmm(quiet.from);
  const to = parseHhmm(quiet.to);
  if (from === to) return false;
  const now = localClock(ts, timeZone).minutes;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function kindEnabled(prefs: Prefs, kind: NotifyKind): boolean {
  return prefs.kinds[kind] ?? kindInfo(kind).defaultOn;
}

/** Whether this destination takes `kind` at `ts`, before any streamer filter. */
export function wantsKind(prefs: Prefs, kind: NotifyKind, ts: number): boolean {
  if (!kindEnabled(prefs, kind)) return false;
  if (inQuietHours(prefs.quietHours, prefs.timeZone, ts)) {
    return prefs.quietHours!.allowHealth && kindInfo(kind).group === "health";
  }
  return true;
}

export function wants(
  prefs: Prefs,
  n: Pick<Notification, "kind" | "streamer">,
  ts: number,
): boolean {
  if (!wantsKind(prefs, n.kind, ts)) return false;
  if (kindInfo(n.kind).group !== "streamers" || prefs.streamers === "all") return true;
  const login = n.streamer?.login.toLowerCase();
  return login !== undefined && prefs.streamers.some((s) => s.toLowerCase() === login);
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `pnpm --filter @app/backend exec vitest run src/notify/`
Expected: PASS (16 tests).

- [ ] **Step 9: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/notify/catalogue.ts apps/backend/src/notify/catalogue.test.ts \
  apps/backend/src/notify/prefs.ts apps/backend/src/notify/prefs.test.ts
git commit -m "feat(notify): add the notification catalogue and per-destination preferences" \
  -m "Every kind with its group, default, urgency, TTL and whether the inbox keeps it; and the preference rules: kind toggles over catalogue defaults, a streamer filter for the streamers group, and quiet hours read in the destination's own time zone." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The notification store

**Files:**
- Modify: `apps/backend/src/db/schema.ts` (append to the `db.exec` block, after `daily_points`)
- Create: `apps/backend/src/notify/store.ts`
- Create: `apps/backend/src/notify/store.test.ts`

**Interfaces:**
- Consumes: `Prefs`, `prefsSchema`, `defaultPrefs`, `SERVER_TIME_ZONE` (Task 1); `NotifyKind` (Task 1); `Db` from `db/schema.ts`.
- Produces, from `notify/store.ts`:
  - `INBOX_RETENTION_MS`, `SEEN_RETENTION_MS`
  - `interface PushSubscriptionJson { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }`
  - `interface Destination { id; channel: "webpush"; label; endpoint: string | null; subscription: PushSubscriptionJson | null; prefs: Prefs; enabled: boolean; createdTs: number; lastOkTs: number | null; lastError: string | null; lastErrorTs: number | null }`
  - `interface InboxRow { id: number; ts: number; kind: NotifyKind; title: string; body: string; streamer: string | null; link: string }`
  - `class NotifyStore(db)` with `list()`, `get(id)`, `byEndpoint(endpoint)`, `upsertWebPush({ subscription, label, timeZone, previousEndpoint?, now }): { destination; created }`, `update(id, { label?, enabled?, prefs? }): Destination | null`, `remove(id): boolean`, `recordOk(id, ts)`, `recordError(id, error, ts)`, `addInbox(row: Omit<InboxRow, "id">): InboxRow`, `inbox(before: number | null, limit: number): InboxRow[]`, `markSeen(key, ts): boolean`, `prune(now): number`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/notify/store.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import { openDb } from "../db/schema.js";
import { NOTIFY_KIND } from "./catalogue.js";
import { INBOX_RETENTION_MS, NotifyStore, SEEN_RETENTION_MS } from "./store.js";

let store: NotifyStore;
beforeEach(() => { store = new NotifyStore(openDb(":memory:")); });

const sub = (endpoint = "https://push.example/abc") => ({
  endpoint, expirationTime: null, keys: { p256dh: "p256", auth: "auth" },
});

test("a new subscription becomes an enabled destination with default prefs", () => {
  const { destination, created } = store.upsertWebPush({
    subscription: sub(), label: "Chrome on Android", timeZone: "Europe/Berlin", now: 5,
  });
  expect(created).toBe(true);
  expect(destination).toMatchObject({
    channel: "webpush", label: "Chrome on Android", endpoint: "https://push.example/abc",
    enabled: true, createdTs: 5, lastOkTs: null,
  });
  expect(destination.prefs.timeZone).toBe("Europe/Berlin");
  expect(store.list()).toHaveLength(1);
});

test("the same endpoint again updates in place and keeps prefs", () => {
  const first = store.upsertWebPush({ subscription: sub(), label: "A", timeZone: "UTC", now: 1 });
  store.update(first.destination.id, { prefs: { ...first.destination.prefs, digestAt: "07:30" } });
  const again = store.upsertWebPush({ subscription: sub(), label: "B", timeZone: "UTC", now: 2 });
  expect(again.created).toBe(false);
  expect(again.destination.id).toBe(first.destination.id);
  expect(again.destination.label).toBe("A");
  expect(again.destination.prefs.digestAt).toBe("07:30");
});

test("a previous endpoint moves its row to the new one", () => {
  const first = store.upsertWebPush({ subscription: sub("https://push.example/old"), label: "A", timeZone: "UTC", now: 1 });
  const moved = store.upsertWebPush({
    subscription: sub("https://push.example/new"), label: "A", timeZone: "UTC",
    previousEndpoint: "https://push.example/old", now: 2,
  });
  expect(moved.created).toBe(false);
  expect(moved.destination.id).toBe(first.destination.id);
  expect(moved.destination.endpoint).toBe("https://push.example/new");
  expect(store.byEndpoint("https://push.example/old")).toBeNull();
});

test("update changes only what it is given", () => {
  const { destination } = store.upsertWebPush({ subscription: sub(), label: "A", timeZone: "UTC", now: 1 });
  const paused = store.update(destination.id, { enabled: false });
  expect(paused).toMatchObject({ enabled: false, label: "A" });
  expect(store.update("missing", { enabled: false })).toBeNull();
});

test("delivery outcomes are recorded", () => {
  const { destination } = store.upsertWebPush({ subscription: sub(), label: "A", timeZone: "UTC", now: 1 });
  store.recordError(destination.id, "push service answered 500", 10);
  expect(store.get(destination.id)).toMatchObject({ lastError: "push service answered 500", lastErrorTs: 10 });
  store.recordOk(destination.id, 20);
  expect(store.get(destination.id)).toMatchObject({ lastOkTs: 20, lastError: null, lastErrorTs: null });
});

test("remove says whether anything went", () => {
  const { destination } = store.upsertWebPush({ subscription: sub(), label: "A", timeZone: "UTC", now: 1 });
  expect(store.remove(destination.id)).toBe(true);
  expect(store.remove(destination.id)).toBe(false);
});

test("the inbox pages newest first", () => {
  for (let i = 1; i <= 5; i++) {
    store.addInbox({ ts: i, kind: NOTIFY_KIND.DROP_CLAIMED, title: `t${i}`, body: "b", streamer: null, link: "/" });
  }
  const first = store.inbox(null, 2);
  expect(first.map((r) => r.title)).toEqual(["t5", "t4"]);
  expect(store.inbox(first[1].id, 10).map((r) => r.title)).toEqual(["t3", "t2", "t1"]);
});

test("a dedupe key is seen once", () => {
  expect(store.markSeen("app.update:1.6.0", 1)).toBe(true);
  expect(store.markSeen("app.update:1.6.0", 2)).toBe(false);
});

test("prune drops old inbox rows and old dedupe keys", () => {
  const now = 1_000 * 86_400_000;
  store.addInbox({ ts: now - INBOX_RETENTION_MS - 1, kind: NOTIFY_KIND.DROP_CLAIMED, title: "old", body: "", streamer: null, link: "/" });
  store.addInbox({ ts: now, kind: NOTIFY_KIND.DROP_CLAIMED, title: "new", body: "", streamer: null, link: "/" });
  store.markSeen("old", now - SEEN_RETENTION_MS - 1);
  expect(store.prune(now)).toBe(1);
  expect(store.inbox(null, 10).map((r) => r.title)).toEqual(["new"]);
  expect(store.markSeen("old", now)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/store.test.ts`
Expected: FAIL, "Failed to resolve import ./store.js".

- [ ] **Step 3: Add the tables**

In `apps/backend/src/db/schema.ts`, inside the `db.exec(` template, directly after the `daily_points` table (before the closing `` `); ``), add:

```sql

    -- One row per place notifications can go. Web Push devices get a
    -- random id. Credentials never live here: prefs are not secrets.
    CREATE TABLE IF NOT EXISTS notify_destinations (
      id            TEXT PRIMARY KEY,
      channel       TEXT    NOT NULL,
      label         TEXT    NOT NULL,
      -- Web Push only: the upsert key, and how a browser finds its own row.
      endpoint      TEXT    UNIQUE,
      subscription  TEXT,
      prefs         TEXT    NOT NULL,
      -- 0 = paused: nothing is sent.
      enabled       INTEGER NOT NULL,
      created_ts    INTEGER NOT NULL,
      last_ok_ts    INTEGER,
      last_error    TEXT,
      last_error_ts INTEGER
    );

    -- The in-app inbox. Only kinds whose catalogue entry says inbox.
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

    -- "Already told them" keys that must survive a restart, such as
    -- 'app.update:1.4.0' or 'campaign.completed:<id>'.
    CREATE TABLE IF NOT EXISTS notify_seen (
      key TEXT PRIMARY KEY,
      ts  INTEGER NOT NULL
    );
```

- [ ] **Step 4: Implement the store**

Create `apps/backend/src/notify/store.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Db } from "../db/schema.js";
import type { NotifyKind } from "./catalogue.js";
import { SERVER_TIME_ZONE, defaultPrefs, prefsSchema, type Prefs } from "./prefs.js";

export const INBOX_RETENTION_MS = 30 * 86_400_000;
export const SEEN_RETENTION_MS = 90 * 86_400_000;

/** What `PushSubscription.toJSON()` produces in the browser. */
export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface Destination {
  id: string;
  channel: "webpush";
  label: string;
  endpoint: string | null;
  subscription: PushSubscriptionJson | null;
  prefs: Prefs;
  enabled: boolean;
  createdTs: number;
  lastOkTs: number | null;
  lastError: string | null;
  lastErrorTs: number | null;
}

export interface InboxRow {
  id: number;
  ts: number;
  kind: NotifyKind;
  title: string;
  body: string;
  streamer: string | null;
  link: string;
}

interface DestinationRow {
  id: string;
  channel: string;
  label: string;
  endpoint: string | null;
  subscription: string | null;
  prefs: string;
  enabled: number;
  created_ts: number;
  last_ok_ts: number | null;
  last_error: string | null;
  last_error_ts: number | null;
}

function toDestination(row: DestinationRow): Destination {
  // A row whose prefs no longer validate (a kind removed since) reads as
  // the defaults rather than failing every list of destinations.
  const parsed = prefsSchema.safeParse(JSON.parse(row.prefs));
  return {
    id: row.id,
    channel: "webpush",
    label: row.label,
    endpoint: row.endpoint,
    subscription: row.subscription === null ? null : JSON.parse(row.subscription),
    prefs: parsed.success ? parsed.data : defaultPrefs(SERVER_TIME_ZONE),
    enabled: row.enabled === 1,
    createdTs: row.created_ts,
    lastOkTs: row.last_ok_ts,
    lastError: row.last_error,
    lastErrorTs: row.last_error_ts,
  };
}

export class NotifyStore {
  constructor(private readonly db: Db) {}

  list(): Destination[] {
    const rows = this.db
      .prepare("SELECT * FROM notify_destinations ORDER BY created_ts, id")
      .all() as DestinationRow[];
    return rows.map(toDestination);
  }

  get(id: string): Destination | null {
    const row = this.db
      .prepare("SELECT * FROM notify_destinations WHERE id = ?")
      .get(id) as DestinationRow | undefined;
    return row === undefined ? null : toDestination(row);
  }

  byEndpoint(endpoint: string): Destination | null {
    const row = this.db
      .prepare("SELECT * FROM notify_destinations WHERE endpoint = ?")
      .get(endpoint) as DestinationRow | undefined;
    return row === undefined ? null : toDestination(row);
  }

  /**
   * Registers a browser, or refreshes one already known.
   *
   * Matched by the new endpoint first and then by `previousEndpoint`, so
   * a browser that had to re-subscribe (a new VAPID key, a rotated
   * subscription) keeps its label and preferences.
   */
  upsertWebPush(input: {
    subscription: PushSubscriptionJson;
    label: string;
    timeZone: string;
    previousEndpoint?: string;
    now: number;
  }): { destination: Destination; created: boolean } {
    const endpoint = input.subscription.endpoint;
    const existing = this.byEndpoint(endpoint)
      ?? (input.previousEndpoint === undefined ? null : this.byEndpoint(input.previousEndpoint));
    if (existing !== null) {
      this.db
        .prepare("UPDATE notify_destinations SET endpoint = ?, subscription = ? WHERE id = ?")
        .run(endpoint, JSON.stringify(input.subscription), existing.id);
      return { destination: this.get(existing.id)!, created: false };
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO notify_destinations
           (id, channel, label, endpoint, subscription, prefs, enabled, created_ts)
         VALUES (?, 'webpush', ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id, input.label, endpoint, JSON.stringify(input.subscription),
        JSON.stringify(defaultPrefs(input.timeZone)), input.now,
      );
    return { destination: this.get(id)!, created: true };
  }

  update(
    id: string,
    patch: { label?: string; enabled?: boolean; prefs?: Prefs },
  ): Destination | null {
    const current = this.get(id);
    if (current === null) return null;
    this.db
      .prepare("UPDATE notify_destinations SET label = ?, enabled = ?, prefs = ? WHERE id = ?")
      .run(
        patch.label ?? current.label,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        JSON.stringify(patch.prefs ?? current.prefs),
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM notify_destinations WHERE id = ?").run(id).changes > 0;
  }

  recordOk(id: string, ts: number): void {
    this.db
      .prepare(
        "UPDATE notify_destinations SET last_ok_ts = ?, last_error = NULL, last_error_ts = NULL WHERE id = ?",
      )
      .run(ts, id);
  }

  recordError(id: string, error: string, ts: number): void {
    this.db
      .prepare("UPDATE notify_destinations SET last_error = ?, last_error_ts = ? WHERE id = ?")
      .run(error, ts, id);
  }

  addInbox(row: Omit<InboxRow, "id">): InboxRow {
    const result = this.db
      .prepare(
        "INSERT INTO notifications (ts, kind, title, body, streamer, link) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.ts, row.kind, row.title, row.body, row.streamer, row.link);
    return { id: Number(result.lastInsertRowid), ...row };
  }

  /** Newest first; `before` is an id, for "load more". */
  inbox(before: number | null, limit: number): InboxRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, kind, title, body, streamer, link FROM notifications
          WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
      )
      .all(before, before, limit) as InboxRow[];
  }

  /** True the first time a key is seen, false every time after. */
  markSeen(key: string, ts: number): boolean {
    return this.db
      .prepare("INSERT OR IGNORE INTO notify_seen (key, ts) VALUES (?, ?)")
      .run(key, ts).changes === 1;
  }

  /** Returns how many inbox rows went. */
  prune(now: number): number {
    const removed = this.db
      .prepare("DELETE FROM notifications WHERE ts < ?")
      .run(now - INBOX_RETENTION_MS).changes;
    this.db.prepare("DELETE FROM notify_seen WHERE ts < ?").run(now - SEEN_RETENTION_MS);
    return removed;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @app/backend exec vitest run src/notify/store.test.ts src/db/`
Expected: PASS. The existing `db` tests still pass with the new tables.

- [ ] **Step 6: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/db/schema.ts apps/backend/src/notify/store.ts apps/backend/src/notify/store.test.ts
git commit -m "feat(notify): store destinations, the inbox and dedupe keys" \
  -m "Three tables in history.db. A browser is upserted by endpoint, or by the endpoint it had before re-subscribing, so its label and preferences survive a new VAPID key." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Batching bursts

**Files:**
- Create: `apps/backend/src/notify/batcher.ts`
- Create: `apps/backend/src/notify/batcher.test.ts`

**Interfaces:**
- Consumes: `Notification`, `NOTIFY_KIND`, `kindInfo` (Task 1).
- Produces:
  - `class Batcher<T>(windowMs: number, flush: (key: string, items: T[]) => void)` with `add(key, item)` and `stop()`
  - `combine(items: readonly Notification[]): Notification`
  - `listNames(names: readonly string[]): string`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/notify/batcher.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Batcher, combine, listNames } from "./batcher.js";
import { NOTIFY_KIND, type Notification } from "./catalogue.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("a bucket flushes once, after the window, with everything that arrived", () => {
  const flush = vi.fn();
  const b = new Batcher<number>(10_000, flush);
  b.add("k", 1);
  vi.advanceTimersByTime(5_000);
  b.add("k", 2);
  expect(flush).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5_000);
  expect(flush).toHaveBeenCalledWith("k", [1, 2]);
  b.add("k", 3);
  vi.advanceTimersByTime(10_000);
  expect(flush).toHaveBeenLastCalledWith("k", [3]);
});

test("keys are batched separately", () => {
  const flush = vi.fn();
  const b = new Batcher<number>(1_000, flush);
  b.add("a", 1);
  b.add("b", 2);
  vi.advanceTimersByTime(1_000);
  expect(flush).toHaveBeenCalledWith("a", [1]);
  expect(flush).toHaveBeenCalledWith("b", [2]);
});

test("stop drops whatever is waiting", () => {
  const flush = vi.fn();
  const b = new Batcher<number>(1_000, flush);
  b.add("a", 1);
  b.stop();
  vi.advanceTimersByTime(1_000);
  expect(flush).not.toHaveBeenCalled();
});

const online = (login: string, ts: number): Notification => ({
  kind: NOTIFY_KIND.STREAMER_ONLINE, title: `${login} is live`, body: "Went live",
  ts, streamer: { login, name: login }, link: `/?open=dashboard&streamer=${login}`,
});

test("a single item passes through unchanged", () => {
  const n = online("alpha", 1);
  expect(combine([n])).toBe(n);
});

test("several streamers collapse into one summary", () => {
  const summary = combine(["alpha", "beta", "gamma", "delta"].map((l, i) => online(l, i)));
  expect(summary).toMatchObject({
    kind: "streamer.online",
    title: "4 streamers went live",
    body: "alpha, beta, gamma and 1 more",
    ts: 3,
    link: "/?open=dashboard",
  });
});

test("several drops collapse into one summary", () => {
  const drop = (body: string, ts: number): Notification => ({
    kind: NOTIFY_KIND.DROP_CLAIMED, title: "Drop claimed", body, ts, link: "/?open=drops",
  });
  expect(combine([drop("Claim A", 1), drop("Claim B", 2)])).toMatchObject({
    title: "2 drops claimed", body: "Claim A · Claim B", link: "/?open=drops",
  });
});

test("names read naturally at every length", () => {
  expect(listNames(["a"])).toBe("a");
  expect(listNames(["a", "b"])).toBe("a and b");
  expect(listNames(["a", "b", "c"])).toBe("a, b and c");
  expect(listNames(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/batcher.test.ts`
Expected: FAIL, "Failed to resolve import ./batcher.js".

- [ ] **Step 3: Implement it**

Create `apps/backend/src/notify/batcher.ts`:

```ts
import { NOTIFY_KIND, kindInfo, type Notification } from "./catalogue.js";

/**
 * Collects items per key for a fixed window after the first one arrives,
 * then hands them over together. The window never extends: a steady
 * trickle still flushes every `windowMs`.
 */
export class Batcher<T> {
  private readonly buckets = new Map<string, { items: T[]; timer: NodeJS.Timeout }>();

  constructor(
    private readonly windowMs: number,
    private readonly flush: (key: string, items: T[]) => void,
  ) {}

  add(key: string, item: T): void {
    const bucket = this.buckets.get(key);
    if (bucket !== undefined) {
      bucket.items.push(item);
      return;
    }
    const items = [item];
    const timer = setTimeout(() => {
      this.buckets.delete(key);
      this.flush(key, items);
    }, this.windowMs);
    // A pending batch must not hold the process open at shutdown.
    timer.unref();
    this.buckets.set(key, { items, timer });
  }

  /** Drops anything still waiting. */
  stop(): void {
    for (const bucket of this.buckets.values()) clearTimeout(bucket.timer);
    this.buckets.clear();
  }
}

/** "a, b, c and 2 more". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** One notification standing for a burst of the same kind. */
export function combine(items: readonly Notification[]): Notification {
  if (items.length === 1) return items[0];
  const last = items[items.length - 1];
  const base = { kind: last.kind, ts: last.ts };
  if (last.kind === NOTIFY_KIND.STREAMER_ONLINE) {
    return {
      ...base,
      title: `${items.length} streamers went live`,
      body: listNames(items.map((i) => i.streamer?.name ?? i.title)),
      link: "/?open=dashboard",
    };
  }
  if (last.kind === NOTIFY_KIND.DROP_CLAIMED) {
    return {
      ...base,
      title: `${items.length} drops claimed`,
      body: items.map((i) => i.body).join(" · "),
      link: "/?open=drops",
    };
  }
  return {
    ...base,
    title: `${kindInfo(last.kind).label} (${items.length})`,
    body: items.map((i) => i.body).join(" · "),
    link: last.link,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/notify/batcher.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/notify/batcher.ts apps/backend/src/notify/batcher.test.ts
git commit -m "feat(notify): collapse bursts of the same kind into one summary" \
  -m "Five streamers going live at once should be one notification, not five." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The notifier

**Files:**
- Modify: `apps/backend/src/appLog/types.ts` (add to `EVENT` and `COMPONENT`)
- Create: `apps/backend/src/notify/notifier.ts`
- Create: `apps/backend/src/notify/notifier.test.ts`

**Interfaces:**
- Consumes: `NotifyStore`, `Destination`, `InboxRow` (Task 2); `Batcher`, `combine` (Task 3); `wants`, `wantsKind` (Task 1); `kindInfo`, `Notification`, `PublishInput`, `NotifyKind` (Task 1); `AppLog`, `NULL_LOG` from `appLog/port.ts`.
- Produces, from `notify/notifier.ts`:
  - `type SendResult = { ok: true } | { ok: false; gone: boolean; error: string }`
  - `interface Channel { send(destination: Destination, notification: Notification): Promise<SendResult> }`
  - `BATCH_WINDOW_MS = 10_000`
  - `class Notifier(deps: NotifierDeps)` with `publish(input: PublishInput): void`, `onInbox(listener: (row: InboxRow) => void): void`, `wantsAny(kind: NotifyKind): boolean`, `markSeen(key: string): boolean`, `sendTo(destination: Destination, n: Notification): Promise<SendResult>`, `stop(): void`
- Produces, in `appLog/types.ts`: `COMPONENT.NOTIFY = "notify"`; `EVENT.NOTIFY_DESTINATION_ADDED = "notify.destination.added"`, `EVENT.NOTIFY_DESTINATION_REMOVED = "notify.destination.removed"`, `EVENT.NOTIFY_DEVICE_EXPIRED = "notify.device.expired"`, `EVENT.NOTIFY_FAILED = "notify.failed"`.

- [ ] **Step 1: Add the log names**

In `apps/backend/src/appLog/types.ts`, add before the `// --- app lifecycle` block inside `EVENT`:

```ts
  // --- notifications -------------------------------------------------
  /** A browser turned notifications on. */
  NOTIFY_DESTINATION_ADDED: "notify.destination.added",
  /** A browser was removed from the Notifications screen. */
  NOTIFY_DESTINATION_REMOVED: "notify.destination.removed",
  /** The push service said the subscription is gone, so the row was deleted. */
  NOTIFY_DEVICE_EXPIRED: "notify.device.expired",
  /** A delivery failed, or a publish threw. */
  NOTIFY_FAILED: "notify.failed",
```

and add `NOTIFY: "notify",` to `COMPONENT` after `CATALOGUE: "catalogue",`.

- [ ] **Step 2: Write the failing test**

Create `apps/backend/src/notify/notifier.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { memoryLog } from "../appLog/memory.js";
import { openDb } from "../db/schema.js";
import { NOTIFY_KIND, type Notification } from "./catalogue.js";
import { Notifier, type Channel } from "./notifier.js";
import { NotifyStore, type Destination } from "./store.js";

let store: NotifyStore;
let sent: Array<{ id: string; n: Notification }>;
let channel: Channel & { send: ReturnType<typeof vi.fn> };
let log: ReturnType<typeof memoryLog>;
let notifier: Notifier;
const NOON = Date.UTC(2026, 8, 23, 10);

beforeEach(() => {
  vi.useFakeTimers();
  store = new NotifyStore(openDb(":memory:"));
  sent = [];
  channel = {
    send: vi.fn(async (d: Destination, n: Notification) => {
      sent.push({ id: d.id, n });
      return { ok: true as const };
    }),
  };
  log = memoryLog();
  notifier = new Notifier({ store, channels: { webpush: channel }, now: () => NOON, log });
});
afterEach(() => { notifier.stop(); vi.useRealTimers(); });

const device = (endpoint: string) => store.upsertWebPush({
  subscription: { endpoint, keys: { p256dh: "p", auth: "a" } },
  label: endpoint, timeZone: "Europe/Berlin", now: 1,
}).destination;

const crash = { kind: NOTIFY_KIND.MINER_CRASHED, title: "Miner crashed", body: "b", link: "/?open=logs" };

test("an inbox kind is stored and announced, a high-volume kind is not", () => {
  const rows: unknown[] = [];
  notifier.onInbox((row) => rows.push(row));
  notifier.publish(crash);
  notifier.publish({ kind: NOTIFY_KIND.RAID_JOINED, title: "Raid", body: "b", link: "/" });
  expect(store.inbox(null, 10).map((r) => r.kind)).toEqual(["miner.crashed"]);
  expect(rows).toHaveLength(1);
});

test("the inbox records even with no destinations at all", () => {
  notifier.publish(crash);
  expect(store.inbox(null, 10)).toHaveLength(1);
  expect(channel.send).not.toHaveBeenCalled();
});

test("delivery goes only to enabled destinations that want the kind", async () => {
  const a = device("https://push.example/a");
  const b = device("https://push.example/b");
  const c = device("https://push.example/c");
  store.update(b.id, { enabled: false });
  store.update(c.id, { prefs: { ...c.prefs, kinds: { "miner.crashed": false } } });
  notifier.publish(crash);
  await vi.runAllTimersAsync();
  expect(sent.map((s) => s.id)).toEqual([a.id]);
  expect(sent[0].n.ts).toBe(NOON);
});

test("a repeated dedupe key is dropped entirely", async () => {
  device("https://push.example/a");
  notifier.publish({ ...crash, dedupeKey: "k" });
  notifier.publish({ ...crash, dedupeKey: "k" });
  await vi.runAllTimersAsync();
  expect(sent).toHaveLength(1);
  expect(store.inbox(null, 10)).toHaveLength(1);
});

test("a dedupe key survives a new notifier on the same store", async () => {
  device("https://push.example/a");
  notifier.publish({ ...crash, dedupeKey: "k" });
  const again = new Notifier({ store, channels: { webpush: channel }, now: () => NOON });
  again.publish({ ...crash, dedupeKey: "k" });
  await vi.runAllTimersAsync();
  expect(sent).toHaveLength(1);
});

test("batchable kinds wait for the window and arrive as one", async () => {
  const a = device("https://push.example/a");
  store.update(a.id, { prefs: { ...a.prefs, kinds: { "streamer.online": true } } });
  for (const login of ["alpha", "beta"]) {
    notifier.publish({
      kind: NOTIFY_KIND.STREAMER_ONLINE, title: `${login} is live`, body: "Went live",
      streamer: { login, name: login }, link: "/",
    });
  }
  expect(sent).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sent).toHaveLength(1);
  expect(sent[0].n.title).toBe("2 streamers went live");
});

test("a follow-up reaches exactly the destinations that got the tagged one", async () => {
  const a = device("https://push.example/a");
  device("https://push.example/b");
  const b = store.list()[1];
  store.update(b.id, { prefs: { ...b.prefs, kinds: { "restart.pending": false } } });
  notifier.publish({ kind: NOTIFY_KIND.RESTART_PENDING, title: "p", body: "b", link: "/", tag: "restart" });
  // a now opts out and b opts in; neither changes who gets the follow-up.
  store.update(a.id, { prefs: { ...a.prefs, kinds: { "restart.pending": false } } });
  store.update(b.id, { prefs: { ...b.prefs, kinds: { "restart.pending": true } } });
  notifier.publish({ kind: NOTIFY_KIND.RESTART_PENDING, title: "c", body: "b", link: "/", tag: "restart", followUp: true });
  await vi.runAllTimersAsync();
  expect(sent.map((s) => [s.n.title, s.id])).toEqual([["p", a.id], ["c", a.id]]);
});

test("a gone subscription deletes its destination", async () => {
  const a = device("https://push.example/a");
  channel.send.mockResolvedValueOnce({ ok: false, gone: true, error: "push service answered 410" });
  notifier.publish(crash);
  await vi.runAllTimersAsync();
  expect(store.get(a.id)).toBeNull();
  expect(log.ofType("notify.device.expired")).toHaveLength(1);
});

test("a failure is recorded on the destination and logged", async () => {
  const a = device("https://push.example/a");
  channel.send.mockResolvedValueOnce({ ok: false, gone: false, error: "push service answered 500" });
  notifier.publish(crash);
  await vi.runAllTimersAsync();
  expect(store.get(a.id)?.lastError).toBe("push service answered 500");
  expect(log.ofType("notify.failed")).toHaveLength(1);
});

test("one failing destination does not stop the others", async () => {
  device("https://push.example/a");
  const b = device("https://push.example/b");
  channel.send.mockRejectedValueOnce(new Error("boom"));
  notifier.publish(crash);
  await vi.runAllTimersAsync();
  expect(sent.map((s) => s.id)).toEqual([b.id]);
});

test("publish never throws", () => {
  const broken = new Notifier({
    store: { markSeen: () => { throw new Error("disk full"); } } as never,
    channels: {}, log,
  });
  expect(() => broken.publish({ ...crash, dedupeKey: "k" })).not.toThrow();
  expect(log.ofType("notify.failed")).toHaveLength(1);
});

test("wantsAny answers whether anyone would take a kind now", () => {
  expect(notifier.wantsAny(NOTIFY_KIND.RESTART_PENDING)).toBe(false);
  const a = device("https://push.example/a");
  expect(notifier.wantsAny(NOTIFY_KIND.RESTART_PENDING)).toBe(true);
  store.update(a.id, { enabled: false });
  expect(notifier.wantsAny(NOTIFY_KIND.RESTART_PENDING)).toBe(false);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/notifier.test.ts`
Expected: FAIL, "Failed to resolve import ./notifier.js".

- [ ] **Step 4: Implement the notifier**

Create `apps/backend/src/notify/notifier.ts`:

```ts
import { NULL_LOG, type AppLog } from "../appLog/port.js";
import { COMPONENT, EVENT } from "../appLog/types.js";
import { Batcher, combine } from "./batcher.js";
import {
  kindInfo, type Notification, type NotifyKind, type PublishInput,
} from "./catalogue.js";
import { wants, wantsKind } from "./prefs.js";
import type { Destination, InboxRow, NotifyStore } from "./store.js";

export type SendResult = { ok: true } | { ok: false; gone: boolean; error: string };

/** Delivers to one kind of destination. Resolves with the outcome; may reject. */
export interface Channel {
  send(destination: Destination, notification: Notification): Promise<SendResult>;
}

export const BATCH_WINDOW_MS = 10_000;

export interface NotifierDeps {
  store: NotifyStore;
  channels: Partial<Record<Destination["channel"], Channel>>;
  now?: () => number;
  log?: AppLog;
  batchWindowMs?: number;
}

interface Queued {
  destination: Destination;
  notification: Notification;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Where every source publishes, and the one place that decides who hears
 * about what.
 *
 * `publish()` is synchronous and never throws, and delivery runs behind
 * it, so a source is never held up by a push service or broken by one.
 */
export class Notifier {
  private readonly listeners: Array<(row: InboxRow) => void> = [];
  /** Who received the latest notification per tag, so a follow-up reaches exactly them. */
  private readonly tagged = new Map<string, Set<string>>();
  private readonly batcher: Batcher<Queued>;
  private readonly log: AppLog;

  constructor(private readonly deps: NotifierDeps) {
    this.log = (deps.log ?? NULL_LOG).child({ component: COMPONENT.NOTIFY });
    this.batcher = new Batcher<Queued>(deps.batchWindowMs ?? BATCH_WINDOW_MS, (_key, items) => {
      void this.sendTo(items[0].destination, combine(items.map((i) => i.notification)));
    });
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Called with each new inbox row; the server pushes it over SSE. */
  onInbox(listener: (row: InboxRow) => void): void {
    this.listeners.push(listener);
  }

  publish(input: PublishInput): void {
    try {
      this.dispatch({ ...input, ts: input.ts ?? this.now() });
    } catch (cause) {
      this.log.error({
        type: EVENT.NOTIFY_FAILED,
        msg: `could not publish ${input.kind}: ${messageOf(cause)}`,
        kind: input.kind,
        err: messageOf(cause),
      });
    }
  }

  private dispatch(n: Notification): void {
    const { store } = this.deps;
    if (n.dedupeKey !== undefined && !store.markSeen(n.dedupeKey, n.ts)) return;
    const info = kindInfo(n.kind);
    if (info.inbox) {
      const row = store.addInbox({
        ts: n.ts, kind: n.kind, title: n.title, body: n.body,
        streamer: n.streamer?.login ?? null, link: n.link,
      });
      for (const listener of this.listeners) listener(row);
    }
    const enabled = store.list().filter((d) => d.enabled);
    const recipients = n.followUp === true
      ? enabled.filter((d) => this.tagged.get(n.tag ?? "")?.has(d.id) === true)
      : enabled.filter((d) => wants(d.prefs, n, n.ts));
    if (n.tag !== undefined && n.followUp !== true) {
      this.tagged.set(n.tag, new Set(recipients.map((d) => d.id)));
    }
    for (const destination of recipients) {
      if (info.batch) {
        this.batcher.add(`${destination.id}|${n.kind}`, { destination, notification: n });
      } else {
        void this.sendTo(destination, n);
      }
    }
  }

  /** Whether any enabled destination would take `kind` right now, streamer filter aside. */
  wantsAny(kind: NotifyKind): boolean {
    const now = this.now();
    return this.deps.store.list().some((d) => d.enabled && wantsKind(d.prefs, kind, now));
  }

  /** Records a dedupe key without publishing. True the first time. */
  markSeen(key: string): boolean {
    return this.deps.store.markSeen(key, this.now());
  }

  /** Delivers straight to one destination, bypassing its preferences, and records the outcome. */
  async sendTo(destination: Destination, n: Notification): Promise<SendResult> {
    const channel = this.deps.channels[destination.channel];
    let result: SendResult;
    if (channel === undefined) {
      result = { ok: false, gone: false, error: `no ${destination.channel} channel` };
    } else {
      try {
        result = await channel.send(destination, n);
      } catch (cause) {
        result = { ok: false, gone: false, error: messageOf(cause) };
      }
    }
    const { store } = this.deps;
    const now = this.now();
    if (result.ok) {
      store.recordOk(destination.id, now);
    } else if (result.gone) {
      store.remove(destination.id);
      this.log.info({
        type: EVENT.NOTIFY_DEVICE_EXPIRED,
        msg: `"${destination.label}" no longer accepts notifications, so it was removed`,
        destinationId: destination.id,
        label: destination.label,
        err: result.error,
      });
    } else {
      store.recordError(destination.id, result.error, now);
      this.log.warn({
        type: EVENT.NOTIFY_FAILED,
        msg: `could not notify "${destination.label}": ${result.error}`,
        destinationId: destination.id,
        kind: n.kind,
        err: result.error,
      });
    }
    return result;
  }

  stop(): void {
    this.batcher.stop();
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/notify/ src/appLog/`
Expected: PASS.

- [ ] **Step 6: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/appLog/types.ts apps/backend/src/notify/notifier.ts apps/backend/src/notify/notifier.test.ts
git commit -m "feat(notify): add the notifier that every source publishes into" \
  -m "It writes inbox kinds to SQLite, fans out to enabled destinations whose preferences want the kind, batches bursty kinds, routes follow-ups to whoever got the tagged original, and deletes a destination whose push subscription is gone. publish() never throws." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: Action tokens

**Files:**
- Create: `apps/backend/src/notify/actions.ts`
- Create: `apps/backend/src/notify/actions.test.ts`

**Interfaces:**
- Produces: `interface TokenAction { kind: "cancel-restart"; dueAt: number }`; `class ActionTokens(now?: () => number)` with `mint(action: TokenAction, expiresAt: number): string` (64 hex chars) and `redeem(token: string): TokenAction | null`.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/src/notify/actions.test.ts`:

```ts
import { expect, test } from "vitest";
import { ActionTokens } from "./actions.js";

const action = { kind: "cancel-restart" as const, dueAt: 5_000 };

test("a token redeems once", () => {
  const tokens = new ActionTokens(() => 1_000);
  const token = tokens.mint(action, 5_000);
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  expect(tokens.redeem(token)).toEqual(action);
  expect(tokens.redeem(token)).toBeNull();
});

test("an expired token redeems nothing", () => {
  let now = 1_000;
  const tokens = new ActionTokens(() => now);
  const token = tokens.mint(action, 5_000);
  now = 5_000;
  expect(tokens.redeem(token)).toBeNull();
});

test("an unknown or malformed token redeems nothing", () => {
  const tokens = new ActionTokens(() => 1_000);
  tokens.mint(action, 5_000);
  expect(tokens.redeem("0".repeat(64))).toBeNull();
  expect(tokens.redeem("not a token")).toBeNull();
});

test("two tokens are independent", () => {
  const tokens = new ActionTokens(() => 1_000);
  const a = tokens.mint(action, 5_000);
  const b = tokens.mint({ ...action, dueAt: 9_000 }, 9_000);
  expect(tokens.redeem(b)?.dueAt).toBe(9_000);
  expect(tokens.redeem(a)?.dueAt).toBe(5_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/actions.test.ts`
Expected: FAIL, "Failed to resolve import ./actions.js".

- [ ] **Step 3: Implement it**

Create `apps/backend/src/notify/actions.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

/**
 * What a token lets its holder do. `dueAt` names one specific pending
 * restart: a later proposal has a different deadline, so an old token
 * can never cancel it.
 */
export interface TokenAction {
  kind: "cancel-restart";
  dueAt: number;
}

const TOKEN = /^[0-9a-f]{64}$/;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Single-use capabilities carried inside a notification.
 *
 * They exist because the Cancel button has to work without a session:
 * sessions last 24 hours and a service worker cannot log in. Held in
 * memory only, keyed by hash; a backend restart drops the pending restart
 * they could cancel anyway.
 */
export class ActionTokens {
  private readonly tokens = new Map<string, { action: TokenAction; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(action: TokenAction, expiresAt: number): string {
    this.sweep();
    const token = randomBytes(32).toString("hex");
    this.tokens.set(hash(token), { action, expiresAt });
    return token;
  }

  redeem(token: string): TokenAction | null {
    if (!TOKEN.test(token)) return null;
    const key = hash(token);
    const entry = this.tokens.get(key);
    this.tokens.delete(key);
    if (entry === undefined || this.now() >= entry.expiresAt) return null;
    return entry.action;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.tokens) {
      if (now >= entry.expiresAt) this.tokens.delete(key);
    }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/notify/actions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/notify/actions.ts apps/backend/src/notify/actions.test.ts
git commit -m "feat(notify): add single-use action tokens" \
  -m "A notification's Cancel button has to work without a session, so it carries a token that can cancel exactly one pending restart and nothing else." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The Web Push channel

**Files:**
- Modify: `apps/backend/package.json` (via pnpm)
- Create: `apps/backend/src/notify/channels/webPush.ts`
- Create: `apps/backend/src/notify/channels/webPush.test.ts`

**Interfaces:**
- Consumes: `Channel`, `SendResult` (Task 4); `Destination`, `PushSubscriptionJson` (Task 2); `kindInfo`, `Notification` (Task 1).
- Produces:
  - `DEFAULT_VAPID_SUBJECT = "https://github.com/vos/twitch-miner-control"`
  - `interface VapidKeys { publicKey: string; privateKey: string }`
  - `loadOrCreateVapid(path: string, generate?: () => VapidKeys): VapidKeys`
  - `interface PushPayload { v: 1; kind: string; title: string; body: string; link: string; ts: number; urgent: boolean; tag?: string; dueAt?: number; actions?: Array<{ action: string; title: string; token: string }> }`
  - `payloadFor(n: Notification): PushPayload`, `topicFor(tag: string): string`
  - `type SendFn = (subscription: PushSubscriptionJson, payload: string, options: RequestOptions) => Promise<unknown>`
  - `class WebPushChannel implements Channel` with constructor `{ vapid: VapidKeys; subject: string; send?: SendFn; sleep?: (ms: number) => Promise<void>; retryDelayMs?: number }`

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @app/backend add web-push@^3.6.7
pnpm --filter @app/backend add -D @types/web-push@^3.6.4
```

Expected: `apps/backend/package.json` lists both, and `pnpm-lock.yaml` changes.

- [ ] **Step 2: Write the failing test**

Create `apps/backend/src/notify/channels/webPush.test.ts`:

```ts
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { NOTIFY_KIND, type Notification } from "../catalogue.js";
import { defaultPrefs } from "../prefs.js";
import type { Destination } from "../store.js";
import { WebPushChannel, loadOrCreateVapid, payloadFor, topicFor } from "./webPush.js";

const dest = (over: Partial<Destination> = {}): Destination => ({
  id: "d1", channel: "webpush", label: "Chrome", endpoint: "https://push.example/a",
  subscription: { endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } },
  prefs: defaultPrefs("UTC"), enabled: true, createdTs: 1,
  lastOkTs: null, lastError: null, lastErrorTs: null, ...over,
});

const pending: Notification = {
  kind: NOTIFY_KIND.RESTART_PENDING, title: "Miner restart pending", body: "Because.",
  ts: 10, link: "/?open=dashboard", tag: "restart", dueAt: 190_000,
  actions: [{ id: "cancel-restart", title: "Cancel restart", token: "t".repeat(64) }],
};

const vapid = { publicKey: "pub", privateKey: "priv" };
const statusError = (statusCode: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`status ${statusCode}`), { statusCode, headers });

test("keys are generated once and then reused", () => {
  const path = join(mkdtempSync(join(tmpdir(), "vapid-")), "vapid.json");
  const generate = vi.fn(() => ({ publicKey: "A", privateKey: "B" }));
  expect(loadOrCreateVapid(path, generate)).toEqual({ publicKey: "A", privateKey: "B" });
  expect(loadOrCreateVapid(path, generate)).toEqual({ publicKey: "A", privateKey: "B" });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8")).publicKey).toBe("A");
});

test("an unreadable key file is replaced", () => {
  const path = join(mkdtempSync(join(tmpdir(), "vapid-")), "vapid.json");
  writeFileSync(path, "{}");
  expect(loadOrCreateVapid(path, () => ({ publicKey: "C", privateKey: "D" })).publicKey).toBe("C");
});

test("the payload carries what the service worker needs, and no more", () => {
  expect(payloadFor(pending)).toEqual({
    v: 1, kind: "restart.pending", title: "Miner restart pending", body: "Because.",
    link: "/?open=dashboard", ts: 10, urgent: true, tag: "restart", dueAt: 190_000,
    actions: [{ action: "cancel-restart", title: "Cancel restart", token: "t".repeat(64) }],
  });
});

test("a follow-up is never urgent", () => {
  expect(payloadFor({ ...pending, followUp: true, actions: undefined }).urgent).toBe(false);
});

test("long text is clipped", () => {
  const p = payloadFor({ ...pending, body: "x".repeat(2_000) });
  expect(p.body.length).toBeLessThanOrEqual(400);
});

test("a topic keeps to the header's alphabet and length", () => {
  expect(topicFor("miner-health")).toBe("miner-health");
  expect(topicFor("a b/c".repeat(20))).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
});

test("a send passes VAPID, TTL, urgency and topic", async () => {
  const send = vi.fn(async () => ({ statusCode: 201 }));
  const channel = new WebPushChannel({ vapid, subject: "https://example.org", send });
  await expect(channel.send(dest(), pending)).resolves.toEqual({ ok: true });
  const [subscription, payload, options] = send.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
  expect(subscription).toEqual(dest().subscription);
  expect(JSON.parse(payload).kind).toBe("restart.pending");
  expect(options).toMatchObject({
    vapidDetails: { subject: "https://example.org", publicKey: "pub", privateKey: "priv" },
    TTL: 90, urgency: "high", topic: "restart",
  });
});

test("404 and 410 mean the subscription is gone", async () => {
  for (const status of [404, 410]) {
    const channel = new WebPushChannel({
      vapid, subject: "s", send: async () => { throw statusError(status); },
    });
    await expect(channel.send(dest(), pending)).resolves.toMatchObject({ ok: false, gone: true });
  }
});

test("a 5xx is retried once after the delay, then reported", async () => {
  const sleep = vi.fn(async () => {});
  const send = vi.fn(async () => { throw statusError(503); });
  const channel = new WebPushChannel({ vapid, subject: "s", send, sleep, retryDelayMs: 30_000 });
  await expect(channel.send(dest(), pending)).resolves.toEqual({
    ok: false, gone: false, error: "push service answered 503",
  });
  expect(send).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(30_000);
});

test("a 429 honours Retry-After, capped at a minute", async () => {
  const sleep = vi.fn(async () => {});
  const send = vi.fn()
    .mockRejectedValueOnce(statusError(429, { "retry-after": "600" }))
    .mockResolvedValueOnce({ statusCode: 201 });
  const channel = new WebPushChannel({ vapid, subject: "s", send, sleep });
  await expect(channel.send(dest(), pending)).resolves.toEqual({ ok: true });
  expect(sleep).toHaveBeenCalledWith(60_000);
});

test("a network error is retried too", async () => {
  const send = vi.fn()
    .mockRejectedValueOnce(new Error("ECONNRESET"))
    .mockResolvedValueOnce({ statusCode: 201 });
  const channel = new WebPushChannel({ vapid, subject: "s", send, sleep: async () => {} });
  await expect(channel.send(dest(), pending)).resolves.toEqual({ ok: true });
});

test("any other 4xx is reported without a retry", async () => {
  const send = vi.fn(async () => { throw statusError(413); });
  const channel = new WebPushChannel({ vapid, subject: "s", send, sleep: async () => {} });
  await expect(channel.send(dest(), pending)).resolves.toMatchObject({ ok: false, gone: false });
  expect(send).toHaveBeenCalledTimes(1);
});

test("a destination without a subscription is gone", async () => {
  const channel = new WebPushChannel({ vapid, subject: "s", send: vi.fn() });
  await expect(channel.send(dest({ subscription: null }), pending))
    .resolves.toMatchObject({ ok: false, gone: true });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/channels/webPush.test.ts`
Expected: FAIL, "Failed to resolve import ./webPush.js".

- [ ] **Step 4: Implement it**

Create `apps/backend/src/notify/channels/webPush.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
// Default import only: web-push is CommonJS, and Node's ESM loader cannot
// see its exports as named imports even though TypeScript and Vitest can.
import webpush from "web-push";
import type { RequestOptions } from "web-push";
import { kindInfo, type Notification } from "../catalogue.js";
import type { Channel, SendResult } from "../notifier.js";
import type { Destination, PushSubscriptionJson } from "../store.js";

/**
 * Apple's push service rejects a `mailto:` at `localhost`, so the default
 * subject is this project's URL. `VAPID_SUBJECT` overrides it.
 */
export const DEFAULT_VAPID_SUBJECT = "https://github.com/vos/twitch-miner-control";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * Reads the key pair, or generates and writes one.
 *
 * The public key is baked into every browser subscription, so replacing
 * it strands them all until each browser next opens the app and
 * re-subscribes (lib/push.ts heals that). The file is created 0600
 * because the private key is what lets anyone push to those browsers.
 */
export function loadOrCreateVapid(
  path: string,
  generate: () => VapidKeys = () => webpush.generateVAPIDKeys(),
): VapidKeys {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VapidKeys>;
      if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch {
      // Unreadable: replaced below, which is the only way forward anyway.
    }
  }
  const keys = generate();
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

/** What the service worker receives. Mirrored in apps/frontend/src/sw/handlers.ts. */
export interface PushPayload {
  v: 1;
  kind: string;
  title: string;
  body: string;
  link: string;
  ts: number;
  /** Keeps the notification on screen until acted on. */
  urgent: boolean;
  tag?: string;
  dueAt?: number;
  actions?: Array<{ action: string; title: string; token: string }>;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export function payloadFor(n: Notification): PushPayload {
  return {
    v: 1,
    kind: n.kind,
    title: clip(n.title, 120),
    body: clip(n.body, 400),
    link: n.link,
    ts: n.ts,
    urgent: kindInfo(n.kind).urgency === "high" && n.followUp !== true,
    ...(n.tag === undefined ? {} : { tag: n.tag }),
    ...(n.dueAt === undefined ? {} : { dueAt: n.dueAt }),
    ...(n.actions === undefined || n.actions.length === 0 ? {} : {
      actions: n.actions.map((a) => ({ action: a.id, title: a.title, token: a.token })),
    }),
  };
}

/**
 * The `Topic` header: a push service replaces an undelivered message with
 * a newer one on the same topic. RFC 8030 limits it to 32 URL-safe base64
 * characters.
 */
export function topicFor(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "tmc";
}

export type SendFn = (
  subscription: PushSubscriptionJson,
  payload: string,
  options: RequestOptions,
) => Promise<unknown>;

export interface WebPushChannelDeps {
  vapid: VapidKeys;
  subject: string;
  send?: SendFn;
  sleep?: (ms: number) => Promise<void>;
  /** Wait before the single retry when the service gives no Retry-After. */
  retryDelayMs?: number;
}

type Attempt =
  | { kind: "done"; result: SendResult }
  | { kind: "retry"; delayMs: number; error: string };

const RETRY_CAP_MS = 60_000;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class WebPushChannel implements Channel {
  private readonly sendFn: SendFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelayMs: number;

  constructor(private readonly deps: WebPushChannelDeps) {
    this.sendFn = deps.send ?? ((subscription, payload, options) =>
      webpush.sendNotification(subscription, payload, options));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryDelayMs = deps.retryDelayMs ?? 30_000;
  }

  async send(destination: Destination, n: Notification): Promise<SendResult> {
    const subscription = destination.subscription;
    if (subscription === null) return { ok: false, gone: true, error: "no push subscription" };
    const info = kindInfo(n.kind);
    const options: RequestOptions = {
      vapidDetails: {
        subject: this.deps.subject,
        publicKey: this.deps.vapid.publicKey,
        privateKey: this.deps.vapid.privateKey,
      },
      TTL: info.ttlSeconds,
      urgency: info.urgency,
      ...(n.tag === undefined ? {} : { topic: topicFor(n.tag) }),
    };
    const payload = JSON.stringify(payloadFor(n));
    const first = await this.attempt(subscription, payload, options);
    if (first.kind === "done") return first.result;
    await this.sleep(first.delayMs);
    const second = await this.attempt(subscription, payload, options);
    return second.kind === "done" ? second.result : { ok: false, gone: false, error: second.error };
  }

  private async attempt(
    subscription: PushSubscriptionJson,
    payload: string,
    options: RequestOptions,
  ): Promise<Attempt> {
    try {
      await this.sendFn(subscription, payload, options);
      return { kind: "done", result: { ok: true } };
    } catch (cause) {
      const status = (cause as { statusCode?: unknown }).statusCode;
      if (typeof status !== "number") {
        return { kind: "retry", delayMs: this.retryDelayMs, error: `push service unreachable: ${messageOf(cause)}` };
      }
      const error = `push service answered ${status}`;
      if (status === 404 || status === 410) return { kind: "done", result: { ok: false, gone: true, error } };
      if (status === 429 || status >= 500) {
        return { kind: "retry", delayMs: retryAfterMs(cause) ?? this.retryDelayMs, error };
      }
      return { kind: "done", result: { ok: false, gone: false, error } };
    }
  }
}

function retryAfterMs(cause: unknown): number | null {
  const header = (cause as { headers?: Record<string, string> }).headers?.["retry-after"];
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RETRY_CAP_MS) : null;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/notify/channels/webPush.test.ts`
Expected: PASS (12 tests).

Run: `pnpm run build:backend`
Expected: no type errors. If `@types/web-push` reports `urgency` or `topic` missing from `RequestOptions`, check the installed version's `index.d.ts`. Both fields are in 3.6.x.

- [ ] **Step 6: Commit (after the user's go-ahead)**

```bash
git add apps/backend/package.json pnpm-lock.yaml apps/backend/src/notify/channels/
git commit -m "feat(notify): deliver through Web Push with a generated VAPID key pair" \
  -m "Keys live in the data directory, created 0600. A gone subscription (404/410) is reported so the notifier deletes it; 429 and 5xx get one retry, honouring Retry-After up to a minute." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Routes and server wiring

**Files:**
- Create: `apps/backend/src/notify/routes.ts`
- Create: `apps/backend/src/notify/routes.test.ts`
- Modify: `apps/backend/src/http/auth.ts:26-33` (the `PUBLIC_ENDPOINTS` set and its comment)
- Modify: `apps/backend/src/http/server.ts` (`ServerDeps`, route registration inside the auth scope, SSE wiring, static headers)
- Modify: `apps/backend/src/http/server.test.ts` (`make()` option and new tests)
- Create: `apps/backend/test/fixtures/public/sw.js`

**Interfaces:**
- Consumes: `NotifyStore`, `Destination` (Task 2); `Notifier` (Task 4); `LISTED`, `GROUPS`, `NOTIFY_KIND` (Task 1); `prefsSchema`, `isTimeZone` (Task 1).
- Produces:
  - `interface NotifyRouteDeps { store: NotifyStore; notifier: Pick<Notifier, "sendTo" | "onInbox">; vapidPublicKey: string; redeemAction: (token: string) => boolean; now?: () => number }`
  - `registerNotifyRoutes(app: FastifyInstance, deps: NotifyRouteDeps & { log?: AppLog }): void`
  - `publicDestination(d: Destination): Omit<Destination, "subscription">`
  - `ServerDeps.notify?: NotifyRouteDeps`
  - Routes: `GET /api/notify/config`, `GET /api/notify/destinations`, `POST /api/notify/destinations`, `PUT /api/notify/destinations/:id`, `POST /api/notify/destinations/:id/remove`, `POST /api/notify/destinations/:id/test`, `GET /api/notify/inbox?before=&limit=`, `POST /api/notify/action` (public).
  - SSE event `notification`, carrying an `InboxRow`.

- [ ] **Step 1: Write the failing routes test**

Create `apps/backend/src/notify/routes.test.ts`:

```ts
import Fastify from "fastify";
import { beforeEach, expect, test, vi } from "vitest";
import { memoryLog } from "../appLog/memory.js";
import { openDb } from "../db/schema.js";
import { NOTIFY_KIND } from "./catalogue.js";
import { registerNotifyRoutes } from "./routes.js";
import { NotifyStore } from "./store.js";

let store: NotifyStore;
let sendTo: ReturnType<typeof vi.fn>;
let redeem: ReturnType<typeof vi.fn>;
let log: ReturnType<typeof memoryLog>;

async function app() {
  const instance = Fastify();
  registerNotifyRoutes(instance, {
    store,
    notifier: { sendTo, onInbox: () => {} } as never,
    vapidPublicKey: "BPublicKey",
    redeemAction: redeem,
    now: () => 42,
    log,
  });
  await instance.ready();
  return instance;
}

beforeEach(() => {
  store = new NotifyStore(openDb(":memory:"));
  sendTo = vi.fn(async () => ({ ok: true }));
  redeem = vi.fn(() => false);
  log = memoryLog();
});

const subscription = {
  endpoint: "https://push.example/abc", expirationTime: null,
  keys: { p256dh: "p256", auth: "auth" },
};

const register = async (a: Awaited<ReturnType<typeof app>>, body: object = {}) => a.inject({
  method: "POST", url: "/api/notify/destinations",
  payload: { subscription, label: "Chrome on Android", timeZone: "Europe/Berlin", ...body },
});

test("config carries the key and the listed catalogue, never the test kind", async () => {
  const res = await (await app()).inject({ url: "/api/notify/config" });
  const body = res.json();
  expect(body.vapidPublicKey).toBe("BPublicKey");
  expect(body.groups[0]).toEqual({ id: "health", label: "Miner health" });
  expect(body.catalogue.some((k: { kind: string }) => k.kind === "test")).toBe(false);
  expect(body.catalogue[0]).toEqual({
    kind: "miner.crashed", group: "health", label: "Miner crashed",
    description: expect.any(String), defaultOn: true,
  });
});

test("registering creates a destination without echoing its keys", async () => {
  const a = await app();
  const res = await register(a);
  expect(res.statusCode).toBe(200);
  expect(res.json().destination).toMatchObject({ label: "Chrome on Android", enabled: true, createdTs: 42 });
  expect(res.json().destination.subscription).toBeUndefined();
  expect(log.ofType("notify.destination.added")).toHaveLength(1);
  const list = await a.inject({ url: "/api/notify/destinations" });
  expect(list.json().destinations).toHaveLength(1);
  expect(list.json().destinations[0].endpoint).toBe(subscription.endpoint);
});

test("registering again is an update, not a second row", async () => {
  const a = await app();
  await register(a);
  await register(a);
  expect(store.list()).toHaveLength(1);
  expect(log.ofType("notify.destination.added")).toHaveLength(1);
});

test("a non-https endpoint or an unknown zone is refused", async () => {
  const a = await app();
  expect((await register(a, { subscription: { ...subscription, endpoint: "http://x" } })).statusCode).toBe(400);
  expect((await register(a, { timeZone: "Mars/Olympus" })).statusCode).toBe(400);
});

test("prefs, label and pause are updated and validated", async () => {
  const a = await app();
  const id = (await register(a)).json().destination.id;
  const prefs = { ...store.get(id)!.prefs, kinds: { "streamer.online": true } };
  const ok = await a.inject({ method: "PUT", url: `/api/notify/destinations/${id}`, payload: { prefs, enabled: false, label: "Phone" } });
  expect(ok.json().destination).toMatchObject({ enabled: false, label: "Phone", prefs: { kinds: { "streamer.online": true } } });
  const bad = await a.inject({ method: "PUT", url: `/api/notify/destinations/${id}`, payload: { prefs: { ...prefs, digestAt: "nine" } } });
  expect(bad.statusCode).toBe(400);
  const missing = await a.inject({ method: "PUT", url: "/api/notify/destinations/nope", payload: { enabled: true } });
  expect(missing.statusCode).toBe(404);
});

test("remove deletes and logs", async () => {
  const a = await app();
  const id = (await register(a)).json().destination.id;
  const res = await a.inject({ method: "POST", url: `/api/notify/destinations/${id}/remove` });
  expect(res.json()).toEqual({ ok: true });
  expect(store.list()).toHaveLength(0);
  expect(log.ofType("notify.destination.removed")).toHaveLength(1);
  expect((await a.inject({ method: "POST", url: `/api/notify/destinations/${id}/remove` })).statusCode).toBe(404);
});

test("test sends a test notification straight to that destination", async () => {
  const a = await app();
  const id = (await register(a)).json().destination.id;
  const res = await a.inject({ method: "POST", url: `/api/notify/destinations/${id}/test` });
  expect(res.json()).toEqual({ ok: true });
  expect(sendTo.mock.calls[0][1]).toMatchObject({ kind: NOTIFY_KIND.TEST, title: "Test notification" });
});

test("a failed test reports the error", async () => {
  sendTo.mockResolvedValueOnce({ ok: false, gone: false, error: "push service answered 403" });
  const a = await app();
  const id = (await register(a)).json().destination.id;
  const res = await a.inject({ method: "POST", url: `/api/notify/destinations/${id}/test` });
  expect(res.json()).toEqual({ ok: false, error: "push service answered 403" });
});

test("the inbox pages and clamps its limit", async () => {
  for (let i = 0; i < 3; i++) {
    store.addInbox({ ts: i, kind: NOTIFY_KIND.DROP_CLAIMED, title: `t${i}`, body: "", streamer: null, link: "/" });
  }
  const a = await app();
  const first = (await a.inject({ url: "/api/notify/inbox?limit=2" })).json().items;
  expect(first.map((r: { title: string }) => r.title)).toEqual(["t2", "t1"]);
  const rest = (await a.inject({ url: `/api/notify/inbox?before=${first[1].id}&limit=500` })).json().items;
  expect(rest.map((r: { title: string }) => r.title)).toEqual(["t0"]);
});

test("an action is carried out once, and a bad token is a 404", async () => {
  redeem.mockReturnValueOnce(true);
  const a = await app();
  const token = "a".repeat(64);
  expect((await a.inject({ method: "POST", url: "/api/notify/action", payload: { token } })).json()).toEqual({ ok: true });
  expect(redeem).toHaveBeenCalledWith(token);
  expect((await a.inject({ method: "POST", url: "/api/notify/action", payload: { token } })).statusCode).toBe(404);
  expect((await a.inject({ method: "POST", url: "/api/notify/action", payload: { token: "short" } })).statusCode).toBe(400);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/routes.test.ts`
Expected: FAIL, "Failed to resolve import ./routes.js".

- [ ] **Step 3: Implement the routes**

Create `apps/backend/src/notify/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NULL_LOG, type AppLog } from "../appLog/port.js";
import { COMPONENT, EVENT } from "../appLog/types.js";
import { GROUPS, LISTED, NOTIFY_KIND } from "./catalogue.js";
import type { Notifier } from "./notifier.js";
import { isTimeZone, prefsSchema } from "./prefs.js";
import type { Destination, NotifyStore } from "./store.js";

export interface NotifyRouteDeps {
  store: NotifyStore;
  notifier: Pick<Notifier, "sendTo" | "onInbox">;
  vapidPublicKey: string;
  /** Carries out a notification action. False when the token is unknown, used or expired. */
  redeemAction: (token: string) => boolean;
  now?: () => number;
}

const https = z.string().max(2048).refine((v) => v.startsWith("https://"), "must be an https URL");

const registerSchema = z.object({
  subscription: z.object({
    endpoint: https,
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
  }),
  label: z.string().trim().min(1).max(60),
  timeZone: z.string().refine(isTimeZone, "unknown time zone"),
  previousEndpoint: z.string().max(2048).optional(),
}).strict();

const updateSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  enabled: z.boolean().optional(),
  prefs: prefsSchema.optional(),
}).strict();

const actionSchema = z.object({ token: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

/** A destination as the API shows it: the subscription's keys stay on the server. */
export function publicDestination(destination: Destination): Omit<Destination, "subscription"> {
  const { subscription: _subscription, ...rest } = destination;
  return rest;
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue === undefined ? "invalid request" : `${issue.path.join(".")}: ${issue.message}`;
}

export function registerNotifyRoutes(
  app: FastifyInstance,
  deps: NotifyRouteDeps & { log?: AppLog },
): void {
  const log = (deps.log ?? NULL_LOG).child({ component: COMPONENT.NOTIFY });
  const now = deps.now ?? Date.now;

  app.get("/api/notify/config", async () => ({
    vapidPublicKey: deps.vapidPublicKey,
    groups: GROUPS,
    catalogue: LISTED.map(({ kind, group, label, description, defaultOn }) => ({
      kind, group, label, description, defaultOn,
    })),
  }));

  app.get("/api/notify/destinations", async () => ({
    destinations: deps.store.list().map(publicDestination),
  }));

  app.post("/api/notify/destinations", async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const { destination, created } = deps.store.upsertWebPush({ ...parsed.data, now: now() });
    if (created) {
      log.info({
        type: EVENT.NOTIFY_DESTINATION_ADDED,
        msg: `notifications turned on for "${destination.label}"`,
        destinationId: destination.id,
        label: destination.label,
      });
    }
    return { destination: publicDestination(destination) };
  });

  app.put("/api/notify/destinations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: firstIssue(parsed.error) });
    const destination = deps.store.update(id, parsed.data);
    if (destination === null) return reply.code(404).send({ error: "no such destination" });
    return { destination: publicDestination(destination) };
  });

  app.post("/api/notify/destinations/:id/remove", async (request, reply) => {
    const { id } = request.params as { id: string };
    const destination = deps.store.get(id);
    if (destination === null || !deps.store.remove(id)) {
      return reply.code(404).send({ error: "no such destination" });
    }
    log.info({
      type: EVENT.NOTIFY_DESTINATION_REMOVED,
      msg: `notifications turned off for "${destination.label}"`,
      destinationId: id,
      label: destination.label,
    });
    return { ok: true };
  });

  app.post("/api/notify/destinations/:id/test", async (request, reply) => {
    const { id } = request.params as { id: string };
    const destination = deps.store.get(id);
    if (destination === null) return reply.code(404).send({ error: "no such destination" });
    const result = await deps.notifier.sendTo(destination, {
      kind: NOTIFY_KIND.TEST,
      title: "Test notification",
      body: `Notifications work on "${destination.label}".`,
      ts: now(),
      link: "/?open=notifications",
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  });

  app.get("/api/notify/inbox", async (request) => {
    const query = request.query as { before?: string; limit?: string };
    const before = Number(query.before);
    const limit = Number(query.limit);
    return {
      items: deps.store.inbox(
        Number.isInteger(before) && before > 0 ? before : null,
        Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50,
      ),
    };
  });

  // Public: see PUBLIC_ENDPOINTS in http/auth.ts. The token is the credential.
  app.post("/api/notify/action", async (request, reply) => {
    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "token required" });
    if (!deps.redeemAction(parsed.data.token)) {
      return reply.code(404).send({ error: "this action is no longer available" });
    }
    return { ok: true };
  });
}
```

- [ ] **Step 4: Run the routes test to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/notify/routes.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Make the action route public**

In `apps/backend/src/http/auth.ts`, replace the `PUBLIC_ENDPOINTS` comment and set:

```ts
/**
 * Endpoints reachable without a session, as `METHOD /matched/route`.
 *
 * `/api/session` is the login exchange itself, and the doorbell carries its
 * own shared token which the route checks (Task 15) — a session cookie would
 * be useless there because the caller is the miner subprocess, not a browser.
 * `/api/notify/action` is pressed from a notification, where no session can
 * exist; its single-use token (notify/actions.ts) is the credential, and it
 * can only cancel the one pending restart it was minted for. Nothing else
 * belongs here: this list is the whole of the public API.
 */
const PUBLIC_ENDPOINTS = new Set([
  "POST /api/session", "POST /internal/doorbell", "POST /api/notify/action",
]);
```

- [ ] **Step 6: Wire the routes into the server**

In `apps/backend/src/http/server.ts`:

1. Add imports next to the others:

```ts
import { registerNotifyRoutes, type NotifyRouteDeps } from "../notify/routes.js";
```

2. In `ServerDeps`, after `pendingRestart`, add:

```ts
  /**
   * The notification routes, inbox feed and action endpoint. Absent in
   * tests that do not exercise them, which then get no /api/notify routes.
   */
  notify?: NotifyRouteDeps;
```

3. Inside `app.register(async (instance) => { ... })`, directly after `hub.register(instance);`, add:

```ts
    if (deps.notify !== undefined) registerNotifyRoutes(instance, { ...deps.notify, log: deps.log });
```

4. After `deps.pendingRestart.setBroadcast?.(...)`, add:

```ts
  // New inbox rows reach an open app at once, in the /api/notify/inbox row shape.
  deps.notify?.notifier.onInbox((row) => hub.broadcast("notification", row));
```

5. Replace `void app.register(fastifyStatic, { root: deps.staticRoot });` with:

```ts
    void app.register(fastifyStatic, {
      root: deps.staticRoot,
      // The service worker must be revalidated on every check, or a
      // browser can run a stale one for up to a day after an upgrade.
      setHeaders: (res, path) => {
        if (path.endsWith("/sw.js")) res.setHeader("Cache-Control", "no-cache");
      },
    });
```

- [ ] **Step 7: Add the fixture and the server tests**

Create `apps/backend/test/fixtures/public/sw.js`:

```js
// Stands in for the built service worker in server.test.ts.
```

In `apps/backend/src/http/server.test.ts`:

1. Add `notify?: NotifyRouteDeps;` to `make()`'s options type, with the import `import type { NotifyRouteDeps } from "../notify/routes.js";`.
2. Pass `notify: options.notify,` in the `buildServer({...})` call.
3. Append these tests at the end of the file:

```ts
// --- notifications ---

const notifyDeps = (redeem: (token: string) => boolean) => ({
  store: { list: () => [], inbox: () => [] } as never,
  notifier: { sendTo: vi.fn(), onInbox: vi.fn() } as never,
  vapidPublicKey: "k",
  redeemAction: redeem,
});

test("a notification action needs no session", async () => {
  const redeem = vi.fn(() => true);
  const local = await make({ notify: notifyDeps(redeem) });
  const res = await local.app.inject({
    method: "POST", url: "/api/notify/action", payload: { token: "b".repeat(64) },
  });
  expect(res.statusCode).toBe(200);
  expect(redeem).toHaveBeenCalledOnce();
});

test("every other notification route still needs a session", async () => {
  const local = await make({ notify: notifyDeps(() => false) });
  for (const url of ["/api/notify/config", "/api/notify/destinations", "/api/notify/inbox"]) {
    expect((await local.app.inject({ url })).statusCode).toBe(401);
  }
});

test("the service worker is served for revalidation", async () => {
  const res = await ctx.app.inject({ url: "/sw.js" });
  expect(res.statusCode).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-cache");
});
```

- [ ] **Step 8: Run the server tests to verify they pass**

Run: `pnpm --filter @app/backend exec vitest run src/http/ src/notify/`
Expected: PASS, the existing suite included. If "the service worker is served for revalidation" fails because `@fastify/static` also sets a `public, max-age=0` header, check which one wins. `setHeaders` runs after the plugin's own defaults, so `no-cache` should stand.

- [ ] **Step 9: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/notify/routes.ts apps/backend/src/notify/routes.test.ts \
  apps/backend/src/http/auth.ts apps/backend/src/http/server.ts apps/backend/src/http/server.test.ts \
  apps/backend/test/fixtures/public/sw.js
git commit -m "feat(api): add the notification routes and the public action endpoint" \
  -m "Config, destinations (register, prefs, pause, remove, test) and the inbox sit behind the session. POST /api/notify/action is public: it takes a single-use token in the body, a fixed path the auth allowlist can match literally. New inbox rows are pushed over SSE, and sw.js is served no-cache." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Miner health sources

**Files:**
- Modify: `apps/backend/src/miner/supervisor.ts` (new `CrashInfo` type; `this.emit("crash", ...)` at the four crash sites)
- Modify: `apps/backend/src/miner/supervisor.test.ts` (append)
- Modify: `apps/backend/src/helpers/loginStatus.ts`, `helpers/loginStatus.test.ts` (append)
- Modify: `apps/backend/src/config/updateCheck.ts`, `config/updateCheck.test.ts` (append inside `describe("UpdateChecker")`)
- Create: `apps/backend/src/notify/sources/health.ts`
- Create: `apps/backend/src/notify/sources/health.test.ts`

**Interfaces:**
- Produces, in `miner/supervisor.ts`:

  ```ts
  export type CrashInfo =
    | { kind: "backoff"; code: number | null; delayMs: number; crashCount: number; maxRestarts: number }
    | { kind: "gaveUp"; crashCount: number; windowMs: number }
    | { kind: "unstartable"; code: number | null; uptimeMs: number }
    | { kind: "spawnFailed"; err: string };
  ```

  The Supervisor emits `"crash"` with a `CrashInfo` before the matching state change.
- Produces: `LoginStatus#onSignedOut(listener: () => void)`, which fires on a logged-in → logged-out transition only.
- Produces: `UpdateChecker#onAvailable(listener: (version: string) => void)`, which fires when `available` becomes a new non-null version.
- Produces, from `notify/sources/health.ts`: `crashNotification(info: CrashInfo): PublishInput` and `watchHealth(deps: HealthDeps): void`, where `HealthDeps = { notifier: Pick<Notifier, "publish">; supervisor: Pick<EventEmitter, "on">; loginStatus: Pick<LoginStatus, "onSignedOut">; updates: Pick<UpdateChecker, "onAvailable" | "available"> }`.

- [ ] **Step 1: Write the failing supervisor tests**

Append to `apps/backend/src/miner/supervisor.test.ts` (and add `type CrashInfo` to its `./supervisor.js` import):

```ts
// --- crash announcements, for notifications ---

test("an unstartable exit is announced as a crash", async () => {
  const s = make("instant", { fastExitMs: 10_000 });
  const crashes: CrashInfo[] = [];
  s.on("crash", (c: CrashInfo) => crashes.push(c));
  await s.start();
  await until(() => s.state === "CRASHED");
  expect(crashes).toEqual([{ kind: "unstartable", code: 1, uptimeMs: expect.any(Number) }]);
});

test("each backed-off crash is announced, then giving up", async () => {
  const s = make("delayed_crash", {
    fastExitMs: 20, backoffBaseMs: 10, maxRestarts: 2, crashWindowMs: 5000,
    env: { FAKE_MODE: "delayed_crash", DIE_AFTER_MS: "40" },
  });
  const crashes: CrashInfo[] = [];
  s.on("crash", (c: CrashInfo) => crashes.push(c));
  await s.start();
  await until(() => crashes.some((c) => c.kind === "gaveUp"), { timeout: 5000 });
  expect(crashes[0]).toMatchObject({ kind: "backoff", code: 1, crashCount: 1, maxRestarts: 2, delayMs: 10 });
  expect(crashes.at(-1)).toMatchObject({ kind: "gaveUp", windowMs: 5000 });
});

test("a missing interpreter is announced as a failed spawn", async () => {
  const s = make("normal", { command: "/nonexistent/interpreter" });
  const crashes: CrashInfo[] = [];
  s.on("crash", (c: CrashInfo) => crashes.push(c));
  await s.start().catch(() => {});
  await until(() => s.state === "CRASHED");
  expect(crashes[0]).toMatchObject({ kind: "spawnFailed", err: expect.any(String) });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/miner/supervisor.test.ts`
Expected: the three new tests FAIL (no `"crash"` events are emitted).

- [ ] **Step 3: Emit the crashes**

In `apps/backend/src/miner/supervisor.ts`:

1. After the `MinerState` type, add:

```ts
/**
 * Why a miner process ended without being asked to, emitted as "crash"
 * just before the state change it causes. Notifications are built from
 * it; the app log records the same moments with more evidence.
 */
export type CrashInfo =
  | { kind: "backoff"; code: number | null; delayMs: number; crashCount: number; maxRestarts: number }
  | { kind: "gaveUp"; crashCount: number; windowMs: number }
  | { kind: "unstartable"; code: number | null; uptimeMs: number }
  | { kind: "spawnFailed"; err: string };
```

2. In `onSpawnError`, directly before `this.setState("CRASHED");`:

```ts
    this.emit("crash", { kind: "spawnFailed", err: err.message } satisfies CrashInfo);
```

3. In `onExit`, in the `uptime < this.fastExit` branch, directly before its `this.setState("CRASHED");`:

```ts
      this.emit("crash", { kind: "unstartable", code, uptimeMs: uptime } satisfies CrashInfo);
```

4. In `scheduleRestart`, in the give-up branch, directly before its `this.setState("CRASHED");`:

```ts
      this.emit("crash", {
        kind: "gaveUp", crashCount: this.restartCount, windowMs: this.crashWindow,
      } satisfies CrashInfo);
```

5. In `scheduleRestart`, directly after the `this.log.warn({ type: EVENT.MINER_RESTART_SCHEDULED, ... });` call and before `await sleep(delay);`:

```ts
    this.emit("crash", {
      kind: "backoff", code, delayMs: delay, crashCount: this.restartCount,
      maxRestarts: this.options.maxRestarts ?? 5,
    } satisfies CrashInfo);
```

- [ ] **Step 4: Run the supervisor tests to verify they pass**

Run: `pnpm --filter @app/backend exec vitest run src/miner/supervisor.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Write the failing login and update tests**

Append to `apps/backend/src/helpers/loginStatus.test.ts` (add `vi` to the vitest import):

```ts
test("signing out is announced only after being signed in", () => {
  const status = new LoginStatus();
  const heard = vi.fn();
  status.onSignedOut(heard);
  status.markLoggedOut(); // never signed in: a dead session at boot, not news
  expect(heard).not.toHaveBeenCalled();
  status.markLoggedIn();
  status.markLoggedOut();
  status.markLoggedOut(); // already out
  expect(heard).toHaveBeenCalledTimes(1);
});
```

Append inside `describe("UpdateChecker", ...)` in `apps/backend/src/config/updateCheck.test.ts`:

```ts
  test("announces each newer release once", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(releaseResponse("v1.2.0"))
      .mockResolvedValueOnce(releaseResponse("v1.2.0"))
      .mockResolvedValueOnce(releaseResponse("v1.3.0"));
    const c = checker("1.1.0", fetchImpl);
    const heard: string[] = [];
    c.onAvailable((v) => heard.push(v));
    await c.check();
    await c.check();
    await c.check();
    expect(heard).toEqual(["1.2.0", "1.3.0"]);
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/helpers/loginStatus.test.ts src/config/updateCheck.test.ts`
Expected: FAIL, "onSignedOut is not a function" and "onAvailable is not a function".

- [ ] **Step 7: Implement both listeners**

In `apps/backend/src/helpers/loginStatus.ts`, replace the class body with:

```ts
export class LoginStatus {
  private loggedIn = false;
  private readonly signedOut: Array<() => void> = [];

  /** True when the user must sign in to Twitch again. */
  get required(): boolean {
    return !this.loggedIn;
  }

  /**
   * Called when a working session is lost. Not called for a session that
   * was never working, so a boot without one announces nothing.
   */
  onSignedOut(listener: () => void): void {
    this.signedOut.push(listener);
  }

  markLoggedIn(): void {
    this.loggedIn = true;
  }

  markLoggedOut(): void {
    const was = this.loggedIn;
    this.loggedIn = false;
    if (was) for (const listener of this.signedOut) listener();
  }
}
```

In `apps/backend/src/config/updateCheck.ts`, inside `UpdateChecker`:

1. Add after `available: string | null = null;`:

```ts
  private readonly listeners: Array<(version: string) => void> = [];

  /** Called when a release newer than any announced before is found. */
  onAvailable(listener: (version: string) => void): void {
    this.listeners.push(listener);
  }
```

2. Replace the line `this.available = isNewer(this.current, tag) ? tag.trim().replace(/^v/, "") : null;` with:

```ts
      const next = isNewer(this.current, tag) ? tag.trim().replace(/^v/, "") : null;
      const changed = next !== null && next !== this.available;
      this.available = next;
      if (changed) for (const listener of this.listeners) listener(next);
```

- [ ] **Step 8: Run them to verify they pass**

Run: `pnpm --filter @app/backend exec vitest run src/helpers/loginStatus.test.ts src/config/updateCheck.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing health source test**

Create `apps/backend/src/notify/sources/health.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { UpdateChecker } from "../../config/updateCheck.js";
import { LoginStatus } from "../../helpers/loginStatus.js";
import { crashNotification, watchHealth } from "./health.js";

function harness(available: string | null = null) {
  const publish = vi.fn();
  const supervisor = new EventEmitter();
  const loginStatus = new LoginStatus();
  const updates = new UpdateChecker({ current: "1.1.0", fetchImpl: vi.fn() });
  updates.available = available;
  watchHealth({ notifier: { publish }, supervisor, loginStatus, updates });
  return { publish, supervisor, loginStatus, updates };
}

test("a crash is published with what happens next, tagged to replace the last one", () => {
  const { publish, supervisor } = harness();
  supervisor.emit("crash", { kind: "backoff", code: 1, delayMs: 8_000, crashCount: 2, maxRestarts: 5 });
  expect(publish).toHaveBeenCalledWith({
    kind: "miner.crashed", tag: "miner-health", link: "/?open=logs",
    title: "Miner crashed",
    body: "It exited with code 1 and restarts in 8 s (crash 2; it stops retrying after 6).",
  });
});

test("each crash kind reads differently", () => {
  expect(crashNotification({ kind: "gaveUp", crashCount: 6, windowMs: 3_600_000 }).title)
    .toBe("Miner stopped after repeated crashes");
  expect(crashNotification({ kind: "unstartable", code: 1, uptimeMs: 300 }).body)
    .toContain("config or environment is broken");
  expect(crashNotification({ kind: "spawnFailed", err: "ENOENT" }).body).toContain("ENOENT");
});

test("recovery is announced only after a crash", () => {
  const { publish, supervisor } = harness();
  supervisor.emit("state", "RUNNING");
  expect(publish).not.toHaveBeenCalled();
  supervisor.emit("crash", { kind: "backoff", code: 1, delayMs: 1_000, crashCount: 1, maxRestarts: 5 });
  supervisor.emit("state", "RESTARTING");
  supervisor.emit("state", "RUNNING");
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
    kind: "miner.recovered", tag: "miner-health",
  }));
  supervisor.emit("state", "STOPPED");
  supervisor.emit("state", "RUNNING");
  expect(publish).toHaveBeenCalledTimes(2);
});

test("losing a working Twitch session is published", () => {
  const { publish, loginStatus } = harness();
  loginStatus.markLoggedIn();
  loginStatus.markLoggedOut();
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({
    kind: "twitch.signedOut", link: "/?open=account",
  }));
});

test("an update is published once per version, including one found before wiring", () => {
  const { publish } = harness("1.2.0");
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({
    kind: "app.update", dedupeKey: "app.update:1.2.0",
    link: "https://github.com/vos/twitch-miner-control/releases/tag/v1.2.0",
  }));
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/sources/health.test.ts`
Expected: FAIL, "Failed to resolve import ./health.js".

- [ ] **Step 11: Implement the health source**

Create `apps/backend/src/notify/sources/health.ts`:

```ts
import type { EventEmitter } from "node:events";
import type { UpdateChecker } from "../../config/updateCheck.js";
import type { LoginStatus } from "../../helpers/loginStatus.js";
import type { CrashInfo, MinerState } from "../../miner/supervisor.js";
import { NOTIFY_KIND, type PublishInput } from "../catalogue.js";
import type { Notifier } from "../notifier.js";

/** One tag for the whole group, so a crash loop replaces one notification instead of stacking them. */
const TAG = "miner-health";
const RELEASE_URL = "https://github.com/vos/twitch-miner-control/releases/tag/v";

function duration(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

const exitCode = (code: number | null) => (code === null ? "" : ` with code ${code}`);

export function crashNotification(info: CrashInfo): PublishInput {
  const base = { kind: NOTIFY_KIND.MINER_CRASHED, tag: TAG, link: "/?open=logs" } as const;
  switch (info.kind) {
    case "backoff":
      return {
        ...base,
        title: "Miner crashed",
        // The supervisor gives up once the count passes maxRestarts.
        body: `It exited${exitCode(info.code)} and restarts in ${duration(info.delayMs)} `
          + `(crash ${info.crashCount}; it stops retrying after ${info.maxRestarts + 1}).`,
      };
    case "gaveUp":
      return {
        ...base,
        title: "Miner stopped after repeated crashes",
        body: `${info.crashCount} crashes in ${duration(info.windowMs)}, so it is no longer `
          + "restarted. Check the Logs page, then start it again.",
      };
    case "unstartable":
      return {
        ...base,
        title: "Miner can't start",
        body: `It exited${exitCode(info.code)} ${duration(info.uptimeMs)} after starting, so the `
          + "config or environment is broken. Check the Logs page.",
      };
    case "spawnFailed":
      return { ...base, title: "Miner can't start", body: `It could not be launched: ${info.err}` };
  }
}

export interface HealthDeps {
  notifier: Pick<Notifier, "publish">;
  supervisor: Pick<EventEmitter, "on">;
  loginStatus: Pick<LoginStatus, "onSignedOut">;
  updates: Pick<UpdateChecker, "onAvailable" | "available">;
}

export function watchHealth(deps: HealthDeps): void {
  const { notifier } = deps;

  // Set by a crash and cleared once the miner runs or is stopped on
  // purpose, so only a recovery from a crash is announced.
  let crashed = false;
  deps.supervisor.on("crash", (info: CrashInfo) => {
    crashed = true;
    notifier.publish(crashNotification(info));
  });
  deps.supervisor.on("state", (state: MinerState) => {
    if (state === "RUNNING" && crashed) {
      notifier.publish({
        kind: NOTIFY_KIND.MINER_RECOVERED, title: "Miner running again",
        body: "It recovered after a crash.", tag: TAG, link: "/?open=dashboard",
      });
    }
    if (state === "RUNNING" || state === "STOPPED") crashed = false;
  });

  deps.loginStatus.onSignedOut(() => {
    notifier.publish({
      kind: NOTIFY_KIND.TWITCH_SIGNED_OUT, title: "Twitch sign-in needed",
      body: "Twitch rejected the stored session. Sign in again to keep mining.",
      link: "/?open=account",
    });
  });

  const announce = (version: string) => notifier.publish({
    kind: NOTIFY_KIND.APP_UPDATE, title: "Update available",
    body: `Version ${version} is out.`,
    link: `${RELEASE_URL}${version}`,
    dedupeKey: `app.update:${version}`,
  });
  deps.updates.onAvailable(announce);
  // A check that finished before this ran would otherwise go unannounced;
  // the dedupe key stops a repeat.
  if (deps.updates.available !== null) announce(deps.updates.available);
}
```

- [ ] **Step 12: Run it to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/notify/sources/health.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 13: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/miner/ apps/backend/src/helpers/loginStatus.ts apps/backend/src/helpers/loginStatus.test.ts \
  apps/backend/src/config/updateCheck.ts apps/backend/src/config/updateCheck.test.ts apps/backend/src/notify/sources/health.*
git commit -m "feat(notify): publish miner crashes, recovery, sign-out and updates" \
  -m "The supervisor announces each crash with what happens next, login status announces losing a working session, and the update checker announces each new release once. One tag for crashes means a crash loop replaces its notification instead of stacking five." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Restart notifications and the Cancel action

**Files:**
- Modify: `apps/backend/src/drops/pendingRestart.ts`
- Modify: `apps/backend/src/drops/pendingRestart.test.ts` (append)
- Create: `apps/backend/src/notify/sources/restart.ts`
- Create: `apps/backend/src/notify/sources/restart.test.ts`

**Interfaces:**
- Consumes: `ActionTokens` (Task 5); `Notifier` (Task 4); `NOTIFY_KIND` (Task 1).
- Produces, in `drops/pendingRestart.ts`:
  - `type CancelVia = "dashboard" | "notification"`
  - `type RestartTransition = { phase: "proposed"; reason: string; dueAt: number } | { phase: "cancelled"; reason: string | null; via: CancelVia } | { phase: "fired"; reason: string | null; ok: boolean }`
  - `PendingRestartDeps.deferralMs?: () => number`, `PendingRestartDeps.onTransition?: (t: RestartTransition) => void`
  - `cancel(via: CancelVia = "dashboard")`
- Produces, from `notify/sources/restart.ts`: `NOTIFIED_DEFERRAL_MS = 180_000`; `class RestartNotifications({ notifier: Pick<Notifier, "publish" | "wantsAny">; tokens: Pick<ActionTokens, "mint" | "redeem">; pending: () => Pick<PendingRestart, "state" | "cancel"> })` with `deferralMs(): number`, `onTransition(t: RestartTransition): void`, `redeem(token: string): boolean`.

- [ ] **Step 1: Write the failing PendingRestart tests**

Append to `apps/backend/src/drops/pendingRestart.test.ts`:

```ts
// --- deferral and transitions, for notifications ---

test("the deferral comes from deferralMs when one is given", async () => {
  const restart = vi.fn(async () => {});
  const p = new PendingRestart({ supervisor: { restart }, deferralMs: () => 180_000 });
  const t0 = Date.now();
  p.propose("pool changed");
  expect(p.state().dueAt).toBe(t0 + 180_000);
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(restart).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(180_000 - RESTART_DEFERRAL_MS);
  expect(restart).toHaveBeenCalledTimes(1);
});

test("a proposal and its firing are reported; a renewal is not", async () => {
  const transitions: unknown[] = [];
  const p = new PendingRestart({
    supervisor: { restart: async () => {} }, onTransition: (t) => transitions.push(t),
  });
  const t0 = Date.now();
  p.propose("pool changed");
  p.propose("pool changed again");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(transitions).toEqual([
    { phase: "proposed", reason: "pool changed", dueAt: t0 + RESTART_DEFERRAL_MS },
    { phase: "fired", reason: "pool changed again", ok: true },
  ]);
});

test("a cancel reports where it came from; cancelling nothing reports nothing", () => {
  const transitions: unknown[] = [];
  const p = new PendingRestart({
    supervisor: { restart: async () => {} }, onTransition: (t) => transitions.push(t),
  });
  p.propose("pool changed");
  p.cancel("notification");
  p.cancel();
  expect(transitions).toHaveLength(2);
  expect(transitions[1]).toEqual({ phase: "cancelled", reason: "pool changed", via: "notification" });
});

test("a failed restart is reported as fired but not ok", async () => {
  const transitions: unknown[] = [];
  const p = new PendingRestart({
    supervisor: { restart: async () => { throw new Error("spawn failed"); } },
    onTransition: (t) => transitions.push(t),
  });
  p.propose("pool changed");
  await p.fireNow();
  expect(transitions.at(-1)).toEqual({ phase: "fired", reason: "pool changed", ok: false });
});

test("fireNow with nothing pending reports nothing", async () => {
  const onTransition = vi.fn();
  const p = new PendingRestart({ supervisor: { restart: async () => {} }, onTransition });
  await p.fireNow();
  expect(onTransition).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/drops/pendingRestart.test.ts`
Expected: the five new tests FAIL.

- [ ] **Step 3: Implement the PendingRestart changes**

In `apps/backend/src/drops/pendingRestart.ts`:

1. After the `PendingState` interface, add:

```ts
export type CancelVia = "dashboard" | "notification";

/** What happened to a restart, for notifications. A renewal is not a transition. */
export type RestartTransition =
  | { phase: "proposed"; reason: string; dueAt: number }
  | { phase: "cancelled"; reason: string | null; via: CancelVia }
  | { phase: "fired"; reason: string | null; ok: boolean };
```

2. In `PendingRestartDeps`, add:

```ts
  /**
   * The deferral for a new proposal. Longer when someone will be
   * notified (see notify/sources/restart.ts); RESTART_DEFERRAL_MS when absent.
   */
  deferralMs?: () => number;
  /** Told of each proposal, cancellation and firing. */
  onTransition?: (transition: RestartTransition) => void;
```

3. In `propose`, replace everything from `this.dueAt = this.clock() + RESTART_DEFERRAL_MS;` to the end of the method with:

```ts
    const deferral = this.deps.deferralMs?.() ?? RESTART_DEFERRAL_MS;
    this.dueAt = this.clock() + deferral;
    this.log.info({
      type: EVENT.RESTART_PROPOSED,
      msg: `restart proposed (${reason}); firing in ${deferral}ms unless cancelled`,
      reason,
      dueAt: this.dueAt,
      renewed: false,
    });
    this.timer = setTimeout(() => {
      void this.fire();
    }, deferral);
    this.announce();
    this.deps.onTransition?.({ phase: "proposed", reason, dueAt: this.dueAt });
```

4. Replace `cancel()` with:

```ts
  /** Drop the pending restart. The next pass may propose a fresh one. */
  cancel(via: CancelVia = "dashboard"): void {
    // Read before clear(), which discards both.
    const reason = this.reason;
    const remainingMs = this.dueAt === null ? null : this.dueAt - this.clock();
    const wasPending = this.timer !== null;
    if (wasPending) {
      this.log.info({
        type: EVENT.USER_RESTART_CANCELLED,
        msg: `pending restart cancelled from the ${via} (${reason ?? "no reason recorded"})`,
        reason,
        remainingMs,
        via,
      });
    }
    this.clear();
    this.announce();
    if (wasPending) this.deps.onTransition?.({ phase: "cancelled", reason, via });
  }
```

5. Replace `fire()` with:

```ts
  private async fire(): Promise<void> {
    const reason = this.reason;
    const wasPending = this.timer !== null;
    // Cleared first, so a fireNow() cannot leave the timer armed to
    // restart a second time a minute later.
    this.clear();
    this.announce();
    this.log.info({
      type: EVENT.RESTART_FIRED,
      msg: `restarting the miner (${reason ?? "no reason recorded"})`,
      reason,
    });
    let ok = true;
    try {
      await this.deps.supervisor.restart();
    } catch (cause) {
      ok = false;
      this.log.error({
        type: EVENT.RESTART_FAILED,
        msg: "the restart failed; the miner is still on the previous config "
          + "and the next pass will propose again",
        reason,
        err: cause instanceof Error ? cause.message : String(cause),
      });
      // A failed restart leaves the miner on the previous config, which
      // is still collecting -- the next reconciliation pass sees the
      // same difference and proposes again.
    }
    if (wasPending) this.deps.onTransition?.({ phase: "fired", reason, ok });
  }
```

- [ ] **Step 4: Run the PendingRestart tests to verify they pass**

Run: `pnpm --filter @app/backend exec vitest run src/drops/pendingRestart.test.ts src/http/server.test.ts`
Expected: PASS, including every existing test. The server's `/api/restart/cancel` still calls `cancel()`, so it is logged as "dashboard".

- [ ] **Step 5: Write the failing source test**

Create `apps/backend/src/notify/sources/restart.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { RESTART_DEFERRAL_MS } from "../../drops/pendingRestart.js";
import { ActionTokens } from "../actions.js";
import { NOTIFIED_DEFERRAL_MS, RestartNotifications } from "./restart.js";

function harness(wants = true) {
  const publish = vi.fn();
  const state = { pending: true, dueAt: 5_000 as number | null, reason: "x" as string | null };
  const cancel = vi.fn();
  const notes = new RestartNotifications({
    notifier: { publish, wantsAny: () => wants },
    tokens: new ActionTokens(() => 1_000),
    pending: () => ({ state: () => state, cancel }),
  });
  return { notes, publish, state, cancel };
}

test("the deferral is longer when someone will be told", () => {
  expect(harness(true).notes.deferralMs()).toBe(NOTIFIED_DEFERRAL_MS);
  expect(harness(false).notes.deferralMs()).toBe(RESTART_DEFERRAL_MS);
});

test("a proposal is published with its due time and a Cancel action", () => {
  const { notes, publish } = harness();
  notes.onTransition({ phase: "proposed", reason: "drop subscriptions resolved new channels", dueAt: 5_000 });
  expect(publish).toHaveBeenCalledWith({
    kind: "restart.pending", title: "Miner restart pending",
    body: "Drop subscriptions resolved new channels. Cancel to keep watching the current channels.",
    link: "/?open=dashboard", tag: "restart", dueAt: 5_000,
    actions: [{ id: "cancel-restart", title: "Cancel restart", token: expect.stringMatching(/^[0-9a-f]{64}$/) }],
  });
});

test("the action's token cancels that restart, once", () => {
  const { notes, publish, cancel } = harness();
  notes.onTransition({ phase: "proposed", reason: "r", dueAt: 5_000 });
  const token = publish.mock.calls[0][0].actions[0].token as string;
  expect(notes.redeem(token)).toBe(true);
  expect(cancel).toHaveBeenCalledWith("notification");
  expect(notes.redeem(token)).toBe(false);
});

test("a token cannot cancel a later restart", () => {
  const { notes, publish, state, cancel } = harness();
  notes.onTransition({ phase: "proposed", reason: "r", dueAt: 5_000 });
  const token = publish.mock.calls[0][0].actions[0].token as string;
  state.dueAt = 9_000;
  expect(notes.redeem(token)).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
});

test("nothing pending means nothing to cancel", () => {
  const { notes, publish, state } = harness();
  notes.onTransition({ phase: "proposed", reason: "r", dueAt: 5_000 });
  state.pending = false;
  expect(notes.redeem(publish.mock.calls[0][0].actions[0].token)).toBe(false);
});

test("cancellation and firing are follow-ups on the same tag", () => {
  const { notes, publish } = harness();
  notes.onTransition({ phase: "cancelled", reason: "r", via: "notification" });
  notes.onTransition({ phase: "fired", reason: "drop subscriptions resolved new channels", ok: true });
  notes.onTransition({ phase: "fired", reason: "r", ok: false });
  expect(publish.mock.calls.map(([n]) => [n.title, n.tag, n.followUp])).toEqual([
    ["Restart cancelled", "restart", true],
    ["Miner restarted", "restart", true],
    ["Restart failed", "restart", true],
  ]);
  expect(publish.mock.calls[0][0].body).toMatch(/^Cancelled from a notification\./);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/sources/restart.test.ts`
Expected: FAIL, "Failed to resolve import ./restart.js".

- [ ] **Step 7: Implement it**

Create `apps/backend/src/notify/sources/restart.ts`:

```ts
import {
  RESTART_DEFERRAL_MS, type PendingRestart, type RestartTransition,
} from "../../drops/pendingRestart.js";
import type { ActionTokens } from "../actions.js";
import { NOTIFY_KIND } from "../catalogue.js";
import type { Notifier } from "../notifier.js";

/**
 * The deferral when someone will be notified. A phone in a pocket needs
 * longer than the dashboard banner's minute to be noticed and answered.
 */
export const NOTIFIED_DEFERRAL_MS = 180_000;

const TAG = "restart";
const LINK = "/?open=dashboard";

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export interface RestartNotificationsDeps {
  notifier: Pick<Notifier, "publish" | "wantsAny">;
  tokens: Pick<ActionTokens, "mint" | "redeem">;
  /** A getter: PendingRestart is built after this, taking deferralMs and onTransition from it. */
  pending: () => Pick<PendingRestart, "state" | "cancel">;
}

export class RestartNotifications {
  constructor(private readonly deps: RestartNotificationsDeps) {}

  deferralMs(): number {
    return this.deps.notifier.wantsAny(NOTIFY_KIND.RESTART_PENDING)
      ? NOTIFIED_DEFERRAL_MS
      : RESTART_DEFERRAL_MS;
  }

  onTransition(t: RestartTransition): void {
    const { notifier } = this.deps;
    const base = { kind: NOTIFY_KIND.RESTART_PENDING, link: LINK, tag: TAG } as const;
    if (t.phase === "proposed") {
      const token = this.deps.tokens.mint({ kind: "cancel-restart", dueAt: t.dueAt }, t.dueAt);
      notifier.publish({
        ...base,
        title: "Miner restart pending",
        body: `${sentence(t.reason)}. Cancel to keep watching the current channels.`,
        dueAt: t.dueAt,
        actions: [{ id: "cancel-restart", title: "Cancel restart", token }],
      });
      return;
    }
    if (t.phase === "cancelled") {
      notifier.publish({
        ...base,
        followUp: true,
        title: "Restart cancelled",
        body: `Cancelled from ${t.via === "notification" ? "a notification" : "the dashboard"}. `
          + "The drops engine proposes it again at its next check if it is still needed.",
      });
      return;
    }
    notifier.publish({
      ...base,
      followUp: true,
      title: t.ok ? "Miner restarted" : "Restart failed",
      body: t.ok
        ? `${sentence(t.reason ?? "the drops engine asked for it")}.`
        : "The miner is still on its previous channels. The drops engine proposes again at its next check.",
    });
  }

  /** The action endpoint's handler. False when there is nothing the token may cancel. */
  redeem(token: string): boolean {
    const action = this.deps.tokens.redeem(token);
    if (action === null) return false;
    const pending = this.deps.pending();
    const state = pending.state();
    if (!state.pending || state.dueAt !== action.dueAt) return false;
    pending.cancel("notification");
    return true;
  }
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/notify/sources/restart.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/drops/pendingRestart.ts apps/backend/src/drops/pendingRestart.test.ts apps/backend/src/notify/sources/restart.*
git commit -m "feat(notify): announce restarts with a Cancel action and a longer window" \
  -m "A proposal is published with a single-use token that cancels exactly that restart; cancellation and firing follow up on the same tag so the device's notification is replaced. When someone will be notified, the deferral is three minutes instead of one." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Streamers and miner events

**Files:**
- Modify: `apps/backend/src/db/history.ts` (`openStreamerSession` returns `boolean`)
- Modify: `apps/backend/src/db/history.test.ts` (append)
- Modify: `apps/backend/src/state/service.ts` (the `"streams"` event)
- Modify: `apps/backend/src/state/service.test.ts` (append)
- Create: `apps/backend/src/notify/sources/streams.ts`, `sources/streams.test.ts`
- Create: `apps/backend/src/notify/sources/doorbell.ts`, `sources/doorbell.test.ts`

**Interfaces:**
- Produces: `History#openStreamerSession(...): boolean`, true exactly when a row was inserted.
- Produces, in `state/service.ts`: `interface StreamsFrame { at: number; started: Array<{ login: string; name: string; startedAt: number }>; ended: Array<{ login: string; name: string }> }`. StateService emits `"streams"` with a `StreamsFrame` after a pass that saw a new stream or an end.
- Produces: `FRESH_STREAM_MS = 30 * 60_000`, `watchStreams({ notifier, stateService })`; `watchDoorbell({ notifier, stateService })`. Both take `notifier: Pick<Notifier, "publish">` and `stateService: Pick<EventEmitter, "on">`.

- [ ] **Step 1: Write the failing history and service tests**

Append to `apps/backend/src/db/history.test.ts`:

```ts
test("opening a session says whether it was a new stream", () => {
  expect(history.openStreamerSession("alpha", "S1", 1000, 500)).toBe(true);
  expect(history.openStreamerSession("alpha", "S1", 1000, 900)).toBe(false);
  expect(history.openStreamerSession("alpha", "S2", 5000, 900)).toBe(true);
});
```

Append to `apps/backend/src/state/service.test.ts`:

```ts
// --- stream transitions, for notifications ---

test("a new stream and its end are each announced once", async () => {
  const { service } = make([
    alpha(100, true, "S1", 5_000), alpha(110, true, "S1", 5_000), alpha(120, false),
  ]);
  const frames: unknown[] = [];
  service.on("streams", (f) => frames.push(f));
  await service.refresh();
  await service.refresh();
  await service.refresh();
  expect(frames).toEqual([
    { at: 10_000, started: [{ login: "alpha", name: "Alpha", startedAt: 5_000 }], ended: [] },
    { at: 10_000, started: [], ended: [{ login: "alpha", name: "Alpha" }] },
  ]);
});

test("the first pass never announces an end", async () => {
  const { service } = make([alpha(100, false)]);
  const frames: unknown[] = [];
  service.on("streams", (f) => frames.push(f));
  await service.refresh();
  expect(frames).toEqual([]);
});

test("a stream recorded before a restart is not announced again", async () => {
  history.openStreamerSession("alpha", "S1", 5_000, 90);
  const { service } = make([alpha(100, true, "S1", 5_000)]);
  const frames: unknown[] = [];
  service.on("streams", (f) => frames.push(f));
  await service.refresh();
  expect(frames).toEqual([]);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/db/history.test.ts src/state/service.test.ts`
Expected: the new tests FAIL. `openStreamerSession` returns `undefined`, and no `"streams"` event is emitted.

- [ ] **Step 3: Return the insert result**

In `apps/backend/src/db/history.ts`, change `openStreamerSession` to return `boolean` and add a doc line:

```ts
  /**
   * ...(existing comment)...
   *
   * Returns whether this sighting inserted the row: true exactly once per
   * stream, which is what makes it a restart-proof "went live" signal.
   */
  openStreamerSession(
    streamer: string,
    streamId: string,
    startTs: number,
    anchorPoints: number | null,
  ): boolean {
    return this.db
      .prepare(
        `INSERT INTO streamer_sessions (streamer, stream_id, start_ts, anchor_points)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (streamer, stream_id) DO NOTHING`,
      )
      .run(streamer, streamId, startTs, anchorPoints).changes === 1;
  }
```

- [ ] **Step 4: Emit the stream transitions**

In `apps/backend/src/state/service.ts`:

1. After the `RawStreamerState` type, add:

```ts
/** New streams and ended ones from one pass, for notifications. */
export interface StreamsFrame {
  at: number;
  started: Array<{ login: string; name: string; startedAt: number }>;
  ended: Array<{ login: string; name: string }>;
}
```

2. Add a field to the `StateService` class, next to its other private state:

```ts
  /**
   * Who was live on the previous pass. Null until the first pass, so a
   * backend that boots never announces a stream that ended while it was down.
   */
  private liveLogins: Set<string> | null = null;
```

3. In the refresh's `for (const s of data.streamers)` loop, declare `const started: StreamsFrame["started"] = [];` directly before the loop, and replace the `openStreamerSession` call block with:

```ts
        if (s.isOnline && s.streamId !== null && s.streamStartedAt !== null) {
          const isNew = this.deps.history.openStreamerSession(
            s.username,
            s.streamId,
            s.streamStartedAt,
            typeof s.points === "number" ? s.points : null,
          );
          if (isNew) {
            started.push({
              login: s.username, name: s.displayName ?? s.username, startedAt: s.streamStartedAt,
            });
          }
        }
```

4. Directly after that loop's closing brace, before the "Nobody is watching" idle check, add:

```ts
      // After the writes and before the idle bail: stream transitions are
      // needed whether or not anyone has the dashboard open.
      const previous = this.liveLogins;
      const ended = previous === null ? [] : data.streamers
        .filter((s) => !s.isOnline && previous.has(s.username))
        .map((s) => ({ login: s.username, name: s.displayName ?? s.username }));
      this.liveLogins = new Set(data.streamers.filter((s) => s.isOnline).map((s) => s.username));
      if (started.length > 0 || ended.length > 0) {
        this.emit("streams", { at, started, ended } satisfies StreamsFrame);
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @app/backend exec vitest run src/db/ src/state/ src/insights/`
Expected: PASS, including the existing suites.

- [ ] **Step 6: Write the failing source tests**

Create `apps/backend/src/notify/sources/streams.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { FRESH_STREAM_MS, watchStreams } from "./streams.js";

test("a fresh stream is published as online; a stale one is not", () => {
  const publish = vi.fn();
  const stateService = new EventEmitter();
  watchStreams({ notifier: { publish }, stateService });
  const at = 10 * FRESH_STREAM_MS;
  stateService.emit("streams", {
    at,
    started: [
      { login: "alpha", name: "Alpha", startedAt: at - 60_000 },
      { login: "beta", name: "Beta", startedAt: at - FRESH_STREAM_MS - 1 },
    ],
    ended: [{ login: "gamma", name: "Gamma" }],
  });
  expect(publish.mock.calls.map(([n]) => [n.kind, n.title, n.streamer.login, n.link])).toEqual([
    ["streamer.online", "Alpha is live", "alpha", "/?open=dashboard&streamer=alpha"],
    ["streamer.offline", "Gamma went offline", "gamma", "/?open=dashboard&streamer=gamma"],
  ]);
});
```

Create `apps/backend/src/notify/sources/doorbell.test.ts`:

```ts
import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { watchDoorbell } from "./doorbell.js";

test("notable miner events are published with the miner's own words", () => {
  const publish = vi.fn();
  const stateService = new EventEmitter();
  watchDoorbell({ notifier: { publish }, stateService });
  stateService.emit("event", { ts: 1, type: "DROP_CLAIM", message: "Claim Drop 1 (Rust)" });
  stateService.emit("event", { ts: 2, type: "GIFT_SUB_RECEIVED", message: null });
  stateService.emit("event", { ts: 3, type: "GAIN_FOR_WATCH", message: "+10" });
  expect(publish.mock.calls.map(([n]) => [n.kind, n.title, n.body])).toEqual([
    ["drop.claimed", "Drop claimed", "Claim Drop 1 (Rust)"],
    ["gift.received", "Gift sub received", "Gift sub received"],
  ]);
});
```

- [ ] **Step 7: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/notify/sources/streams.test.ts src/notify/sources/doorbell.test.ts`
Expected: FAIL, the imports do not resolve.

- [ ] **Step 8: Implement both**

Create `apps/backend/src/notify/sources/streams.ts`:

```ts
import type { EventEmitter } from "node:events";
import type { StreamsFrame } from "../../state/service.js";
import { NOTIFY_KIND } from "../catalogue.js";
import type { Notifier } from "../notifier.js";

/**
 * How recently a stream must have started to be announced as going live.
 * A backend back from downtime finds streams that began hours ago as new
 * rows; announcing those would be old news.
 */
export const FRESH_STREAM_MS = 30 * 60_000;

const link = (login: string) => `/?open=dashboard&streamer=${encodeURIComponent(login)}`;

export function watchStreams(deps: {
  notifier: Pick<Notifier, "publish">;
  stateService: Pick<EventEmitter, "on">;
}): void {
  deps.stateService.on("streams", (frame: StreamsFrame) => {
    for (const s of frame.started) {
      if (frame.at - s.startedAt > FRESH_STREAM_MS) continue;
      deps.notifier.publish({
        kind: NOTIFY_KIND.STREAMER_ONLINE, title: `${s.name} is live`, body: "Went live.",
        streamer: { login: s.login, name: s.name }, link: link(s.login),
      });
    }
    for (const s of frame.ended) {
      deps.notifier.publish({
        kind: NOTIFY_KIND.STREAMER_OFFLINE, title: `${s.name} went offline`, body: "The stream ended.",
        streamer: { login: s.login, name: s.name }, link: link(s.login),
      });
    }
  });
}
```

Create `apps/backend/src/notify/sources/doorbell.ts`:

```ts
import type { EventEmitter } from "node:events";
import { NOTIFY_KIND, type NotifyKind } from "../catalogue.js";
import type { Notifier } from "../notifier.js";

/** The miner's Events worth a notification, by doorbell type. */
export const DOORBELL_KINDS: ReadonlyMap<string, { kind: NotifyKind; title: string; link: string }> = new Map([
  ["DROP_CLAIM", { kind: NOTIFY_KIND.DROP_CLAIMED, title: "Drop claimed", link: "/?open=drops" }],
  ["BET_WIN", { kind: NOTIFY_KIND.PREDICTION_WON, title: "Prediction won", link: "/?open=dashboard" }],
  ["BET_LOSE", { kind: NOTIFY_KIND.PREDICTION_LOST, title: "Prediction lost", link: "/?open=dashboard" }],
  ["GAIN_FOR_WATCH_STREAK", { kind: NOTIFY_KIND.STREAK_EARNED, title: "Watch streak bonus", link: "/?open=dashboard" }],
  ["JOIN_RAID", { kind: NOTIFY_KIND.RAID_JOINED, title: "Raid joined", link: "/?open=dashboard" }],
  ["CHAT_MENTION", { kind: NOTIFY_KIND.CHAT_MENTION, title: "Mentioned in chat", link: "/?open=dashboard" }],
  ["GIFT_SUB_RECEIVED", { kind: NOTIFY_KIND.GIFT_RECEIVED, title: "Gift sub received", link: "/?open=dashboard" }],
]);

/**
 * Publishes from the feed rows the doorbell records. The body is the
 * miner's own formatted line, which names the streamer; see
 * python/helpers/doorbell.py.
 */
export function watchDoorbell(deps: {
  notifier: Pick<Notifier, "publish">;
  stateService: Pick<EventEmitter, "on">;
}): void {
  deps.stateService.on("event", (row: { type: string; message: string | null }) => {
    const mapped = DOORBELL_KINDS.get(row.type);
    if (mapped === undefined) return;
    deps.notifier.publish({
      kind: mapped.kind, title: mapped.title, body: row.message ?? mapped.title, link: mapped.link,
    });
  });
}
```

- [ ] **Step 9: Run them to verify they pass**

Run: `pnpm --filter @app/backend exec vitest run src/notify/sources/`
Expected: PASS.

- [ ] **Step 10: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/db/history.ts apps/backend/src/db/history.test.ts \
  apps/backend/src/state/service.ts apps/backend/src/state/service.test.ts \
  apps/backend/src/notify/sources/streams.* apps/backend/src/notify/sources/doorbell.*
git commit -m "feat(notify): publish streams going live or offline, and notable miner events" \
  -m "Going live is a new streamer_sessions row, keyed by Twitch's stream id, so a miner or backend restart mid-stream stays quiet; a stream older than 30 minutes is not announced. Going offline is an in-process transition, never read at boot. Drop claims, predictions, streaks, raids, mentions and gift subs come from the doorbell's feed rows." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Campaign notifications

**Files:**
- Modify: `apps/backend/src/drops/engine.ts` (`CampaignStart`, `EngineDeps.onCampaignStarted`, two call sites)
- Modify: `apps/backend/src/drops/engine.test.ts` (`make()` option; append tests)
- Create: `apps/backend/src/notify/sources/campaigns.ts`
- Create: `apps/backend/src/notify/sources/campaigns.test.ts`

**Interfaces:**
- Produces, in `drops/engine.ts`: `interface CampaignStart { subscriptionId: string; label: string; targetId: string; why: "opened" | "queue" }`, `EngineDeps.onCampaignStarted?: (event: CampaignStart) => void`.
- Produces, from `notify/sources/campaigns.ts`: `CAMPAIGN_WATCH_MS = 15 * 60_000`, `ENDING_SOON_MS = 24 * 3_600_000`, `campaignStartedNotification(e: CampaignStart): PublishInput`, `class CampaignWatcher(deps: CampaignWatcherDeps)` with `start()`, `stop()`, `pass(): Promise<void>`. `CampaignWatcherDeps = { notifier: Pick<Notifier, "publish" | "wantsAny" | "markSeen">; catalogue: Pick<CampaignCatalogue, "get">; inventory: Pick<InventoryCache, "get">; subscribedGames: () => string[]; now?: () => number; intervalMs?: number }`.

- [ ] **Step 1: Write the failing engine tests**

In `apps/backend/src/drops/engine.test.ts`:

1. Add `onCampaignStarted?: (e: unknown) => void;` to `make()`'s `over` type, and pass `onCampaignStarted: over.onCampaignStarted,` in the `new SubscriptionEngine({...})` call, next to `log: over.log,`.
2. Append:

```ts
// --- campaign starts, for notifications ---

test("a scheduled campaign opening is reported", async () => {
  const started = vi.fn();
  let now = 1_000;
  const { engine } = make({
    now: () => now,
    onCampaignStarted: started,
    catalogue: { campaigns: [campaign({ startsAt: 1_000 + HOUR })] },
  });
  await engine.pass();
  expect(started).not.toHaveBeenCalled();
  now += HOUR + 1;
  await engine.pass();
  expect(started).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: "s1", why: "opened" }));
});

test("the queue moving on is reported", async () => {
  const started = vi.fn();
  const { engine } = queued({
    onCampaignStarted: started,
    config: { streamers: [], subscriptions: twoSubs, campaignQueue: true },
  });
  await engine.pass();
  expect(started).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: "s1", why: "queue" }));
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @app/backend exec vitest run src/drops/engine.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Report the starts from the engine**

In `apps/backend/src/drops/engine.ts`:

1. Directly above `export interface EngineDeps`, add:

```ts
/** A subscription that has just started collecting, for notifications. */
export interface CampaignStart {
  subscriptionId: string;
  label: string;
  targetId: string;
  /** A scheduled campaign opened, or the queue moved on to it. */
  why: "opened" | "queue";
}
```

2. In `EngineDeps`, add:

```ts
  /** Told when a subscription starts collecting. */
  onCampaignStarted?: (event: CampaignStart) => void;
```

3. Directly after the `this.log.info({ type: EVENT.SUBSCRIPTION_OPENED, ... });` call, add:

```ts
        this.deps.onCampaignStarted?.({
          subscriptionId: sub.id, label: sub.label, targetId: sub.targetId, why: "opened",
        });
```

4. Directly after the `this.log.info({ type: EVENT.QUEUE_STARTED, ... });` call, add:

```ts
        this.deps.onCampaignStarted?.({
          subscriptionId: sub.id, label: sub.label, targetId: sub.targetId, why: "queue",
        });
```

- [ ] **Step 4: Run the engine tests to verify they pass**

Run: `pnpm --filter @app/backend exec vitest run src/drops/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing watcher test**

Create `apps/backend/src/notify/sources/campaigns.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import type { Campaign, Catalogue } from "../../state/campaignCatalogue.js";
import type { InventorySnapshot } from "../../state/inventory.js";
import type { PublishInput } from "../catalogue.js";
import { CampaignWatcher, ENDING_SOON_MS, campaignStartedNotification } from "./campaigns.js";

const NOW = 1_000_000_000;
const HOUR = 3_600_000;

const campaign = (id: string, over: Partial<Campaign> = {}): Campaign => ({
  id, name: `Campaign ${id}`, game: { id: "g1", slug: "rust", displayName: "Rust" },
  startsAt: null, endsAt: NOW + 10 * 24 * HOUR,
  drops: ["d1", "d2"].map((d) => ({
    id: `${id}-${d}`, name: d, benefits: [], requiredMinutes: 60, requiredSubs: 0,
  })) as never,
  ...over,
});

const claimed = { minutes: 60, claimed: true, instanceId: null };
const halfway = { minutes: 30, claimed: false, instanceId: null };

function harness(opts: { wants?: boolean; games?: string[] } = {}) {
  const seen = new Set<string>();
  const markSeen = (key: string) => (seen.has(key) ? false : (seen.add(key), true));
  const published: PublishInput[] = [];
  const publish = vi.fn((n: PublishInput) => {
    if (n.dedupeKey !== undefined && !markSeen(n.dedupeKey)) return;
    published.push(n);
  });
  let campaigns: Campaign[] = [];
  let progress: InventorySnapshot["progress"] = {};
  const catalogueGet = vi.fn(async (): Promise<Catalogue> => ({
    campaigns, fetchedAt: 1, stale: false, available: true, error: null,
  }));
  const watcher = new CampaignWatcher({
    notifier: { publish, wantsAny: () => opts.wants ?? true, markSeen },
    catalogue: { get: catalogueGet },
    inventory: { get: async () => ({ progress, earned: {}, fetchedAt: 1, available: true }) },
    subscribedGames: () => opts.games ?? [],
    now: () => NOW,
  });
  return {
    watcher, published, catalogueGet,
    set: (c: Campaign[], p: InventorySnapshot["progress"]) => { campaigns = c; progress = p; },
  };
}

test("nothing is fetched while nobody wants campaign notifications", async () => {
  const h = harness({ wants: false });
  await h.watcher.pass();
  expect(h.catalogueGet).not.toHaveBeenCalled();
});

test("the first run ever stays quiet about completions it finds, later ones are published once", async () => {
  const h = harness();
  h.set([campaign("c1")], { c1: { "c1-d1": claimed, "c1-d2": claimed } });
  await h.watcher.pass();
  expect(h.published).toEqual([]);
  h.set([campaign("c1"), campaign("c2")], {
    c1: { "c1-d1": claimed, "c1-d2": claimed },
    c2: { "c2-d1": claimed, "c2-d2": claimed },
  });
  await h.watcher.pass();
  await h.watcher.pass();
  expect(h.published.map((n) => [n.kind, n.link])).toEqual([
    ["campaign.completed", "/?open=drops&campaign=c2"],
  ]);
});

test("a campaign ending soon with progress is published once", async () => {
  const h = harness();
  h.set([
    campaign("soon", { endsAt: NOW + 3 * HOUR }),
    campaign("later", { endsAt: NOW + ENDING_SOON_MS + HOUR }),
    campaign("untouched", { endsAt: NOW + 3 * HOUR }),
  ], {
    soon: { "soon-d1": halfway },
    later: { "later-d1": halfway },
  });
  await h.watcher.pass();
  await h.watcher.pass();
  expect(h.published.map((n) => [n.kind, n.body])).toEqual([
    ["campaign.endingSoon", "\"Campaign soon\" ends in 3 h with drops still unclaimed."],
  ]);
});

test("a new campaign is published only for a subscribed game, never on the first pass", async () => {
  const h = harness({ games: ["g1"] });
  h.set([campaign("c1")], {});
  await h.watcher.pass();
  h.set([
    campaign("c1"),
    campaign("c2"),
    campaign("c3", { game: { id: "g9", slug: "other", displayName: "Other" } }),
  ], {});
  await h.watcher.pass();
  expect(h.published.map((n) => [n.kind, n.title])).toEqual([["campaign.new", "New campaign"]]);
  expect(h.published[0].body).toBe("\"Campaign c2\" for Rust was announced.");
});

test("a campaign start reads as what happened", () => {
  expect(campaignStartedNotification({ subscriptionId: "s1", label: "Rust Drops", targetId: "c1", why: "queue" }))
    .toEqual({
      kind: "campaign.started", title: "Campaign started",
      body: "\"Rust Drops\" is next in the queue and is now being collected.",
      link: "/?open=drops&campaign=c1",
    });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/sources/campaigns.test.ts`
Expected: FAIL, "Failed to resolve import ./campaigns.js".

- [ ] **Step 7: Implement the watcher**

Create `apps/backend/src/notify/sources/campaigns.ts`:

```ts
import type { CampaignStart } from "../../drops/engine.js";
import type { Campaign, CampaignCatalogue } from "../../state/campaignCatalogue.js";
import { resolveCampaign } from "../../state/dropState.js";
import type { InventoryCache } from "../../state/inventory.js";
import { NOTIFY_KIND, type PublishInput } from "../catalogue.js";
import type { Notifier } from "../notifier.js";

/** The drops engine's own cadence; the catalogue and inventory are cached on it. */
export const CAMPAIGN_WATCH_MS = 15 * 60_000;
export const ENDING_SOON_MS = 24 * 3_600_000;

/** Set on the first run ever; see pass(). */
const PRIMED_KEY = "campaign.watch.primed";

const link = (id: string) => `/?open=drops&campaign=${encodeURIComponent(id)}`;
const forGame = (c: Campaign) => (c.game === null ? "" : ` for ${c.game.displayName}`);

export function campaignStartedNotification(e: CampaignStart): PublishInput {
  return {
    kind: NOTIFY_KIND.CAMPAIGN_STARTED,
    title: "Campaign started",
    body: e.why === "opened"
      ? `"${e.label}" has opened, so its channels are being mined.`
      : `"${e.label}" is next in the queue and is now being collected.`,
    link: link(e.targetId),
  };
}

export interface CampaignWatcherDeps {
  notifier: Pick<Notifier, "publish" | "wantsAny" | "markSeen">;
  catalogue: Pick<CampaignCatalogue, "get">;
  inventory: Pick<InventoryCache, "get">;
  /** Game ids the user has a game subscription for. */
  subscribedGames: () => string[];
  now?: () => number;
  intervalMs?: number;
}

/**
 * Completed, ending-soon and new campaigns.
 *
 * Covers every campaign with progress, subscribed or not, which is why
 * it watches the inventory itself rather than hooking the engine. Each
 * notification fires once per campaign, via a persisted dedupe key.
 */
export class CampaignWatcher {
  private timer: NodeJS.Timeout | null = null;
  /** Campaign ids on the previous pass; null until one has run. */
  private known: Set<string> | null = null;

  constructor(private readonly deps: CampaignWatcherDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.pass(), this.deps.intervalMs ?? CAMPAIGN_WATCH_MS);
    this.timer.unref();
    void this.pass();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async pass(): Promise<void> {
    try {
      await this.run();
    } catch {
      // The catalogue and inventory degrade on their own; a throw here
      // is retried on the next tick.
    }
  }

  private async run(): Promise<void> {
    const { notifier } = this.deps;
    const wantsDone = notifier.wantsAny(NOTIFY_KIND.CAMPAIGN_COMPLETED);
    const wantsEnding = notifier.wantsAny(NOTIFY_KIND.CAMPAIGN_ENDING_SOON);
    const wantsNew = notifier.wantsAny(NOTIFY_KIND.CAMPAIGN_NEW);
    // Without a baseline kept current, turning the kind back on would
    // announce everything that appeared meanwhile.
    if (!wantsNew) this.known = null;
    if (!wantsDone && !wantsEnding && !wantsNew) return;

    const catalogue = await this.deps.catalogue.get();
    if (!catalogue.available) return;
    const now = this.now();
    if (wantsNew) this.announceNew(catalogue.campaigns);
    if (!wantsDone && !wantsEnding) return;

    const inventory = await this.deps.inventory.get();
    if (!inventory.available) return;
    // The first run ever marks completions already there as seen, so
    // turning the kind on does not announce a backlog.
    const priming = wantsDone && notifier.markSeen(PRIMED_KEY);

    for (const campaign of catalogue.campaigns) {
      const resolved = resolveCampaign(campaign, inventory);
      if (wantsDone && resolved.complete) {
        const key = `campaign.completed:${campaign.id}`;
        if (priming) {
          notifier.markSeen(key);
        } else {
          notifier.publish({
            kind: NOTIFY_KIND.CAMPAIGN_COMPLETED, title: "Campaign complete",
            body: `Every drop in "${campaign.name}"${forGame(campaign)} is collected.`,
            link: link(campaign.id), dedupeKey: key,
          });
        }
      }
      const endsAt = campaign.endsAt;
      if (wantsEnding && resolved.status === "partial" && endsAt !== null
          && endsAt > now && endsAt - now <= ENDING_SOON_MS) {
        const hours = Math.max(1, Math.round((endsAt - now) / 3_600_000));
        notifier.publish({
          kind: NOTIFY_KIND.CAMPAIGN_ENDING_SOON, title: "Campaign ending soon",
          body: `"${campaign.name}" ends in ${hours} h with drops still unclaimed.`,
          link: link(campaign.id), dedupeKey: `campaign.endingSoon:${campaign.id}`,
        });
      }
    }
  }

  private announceNew(campaigns: readonly Campaign[]): void {
    const known = this.known;
    this.known = new Set(campaigns.map((c) => c.id));
    if (known === null) return;
    const games = new Set(this.deps.subscribedGames());
    for (const c of campaigns) {
      if (known.has(c.id) || c.game === null || !games.has(c.game.id)) continue;
      this.deps.notifier.publish({
        kind: NOTIFY_KIND.CAMPAIGN_NEW, title: "New campaign",
        body: `"${c.name}"${forGame(c)} was announced.`,
        link: link(c.id), dedupeKey: `campaign.new:${c.id}`,
      });
    }
  }
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/notify/sources/campaigns.test.ts src/drops/`
Expected: PASS.

- [ ] **Step 9: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/drops/engine.ts apps/backend/src/drops/engine.test.ts apps/backend/src/notify/sources/campaigns.*
git commit -m "feat(notify): publish campaigns completing, ending soon, starting and appearing" \
  -m "A watcher on the engine's 15-minute cadence reads the cached catalogue and inventory, and only while some destination wants one of its kinds. Each fires once per campaign. The very first run stays quiet about completions it finds, so turning the kind on does not announce a backlog." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The daily digest

**Files:**
- Modify: `apps/backend/src/insights/recap.ts` (add `DaySummary`, `buildDaySummary`)
- Modify: `apps/backend/src/insights/recap.test.ts` (append)
- Create: `apps/backend/src/notify/sources/digest.ts`
- Create: `apps/backend/src/notify/sources/digest.test.ts`

**Interfaces:**
- Produces, in `insights/recap.ts`: `interface DaySummary { day: string; earned: number; minedMs: number; dropsClaimed: number; top: { login: string; displayName: string | null; earned: number } | null; hasData: boolean }` and `buildDaySummary(deps: InsightsDeps, day: string, now: number): DaySummary`.
- Produces, from `notify/sources/digest.ts`: `DIGEST_TICK_MS = 60_000`, `digestNotification(s: DaySummary): Omit<Notification, "ts">`, and `class DigestScheduler({ notifier: Pick<Notifier, "sendTo" | "markSeen">; store: Pick<NotifyStore, "list">; summary: (day: string) => DaySummary; now?; tickMs? })` with `start()`, `stop()`, `tick()`.

- [ ] **Step 1: Write the failing summary test**

Append to `apps/backend/src/insights/recap.test.ts` (add `buildDaySummary` to the `./recap.js` import):

```ts
// --- one day, for the digest ---

test("a day's summary adds up that day alone", () => {
  seed();
  history.recordEvent("DROP_CLAIM", at(9, 14, 9), "Claim X", "alpha");
  expect(buildDaySummary(deps(), "2026-09-14", NOW)).toEqual({
    day: "2026-09-14",
    earned: 400,
    minedMs: 5 * HOUR,
    dropsClaimed: 1,
    top: { login: "beta", displayName: "Beta", earned: 300 },
    hasData: true,
  });
});

test("a day with nothing recorded says so", () => {
  seed();
  expect(buildDaySummary(deps(), "2026-09-12", NOW)).toMatchObject({ hasData: false, earned: 0, top: null });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/insights/recap.test.ts`
Expected: FAIL, "buildDaySummary is not a function".

- [ ] **Step 3: Implement it**

In `apps/backend/src/insights/recap.ts`, add `dayStart` to the `./days.js` import, then append:

```ts
/** One day in figures, for the daily digest. */
export interface DaySummary {
  day: string;
  earned: number;
  minedMs: number;
  dropsClaimed: number;
  top: { login: string; displayName: string | null; earned: number } | null;
  hasData: boolean;
}

export function buildDaySummary(deps: InsightsDeps, day: string, now: number): DaySummary {
  const from = dayStart(day);
  const to = dayStart(addDays(day, 1));
  const summary = summarise(deps, from, to, now);
  let top: { login: string; earned: number } | null = null;
  for (const [login, figures] of summary.channels) {
    if (figures.earned > 0 && (top === null || figures.earned > top.earned)) {
      top = { login, earned: figures.earned };
    }
  }
  const displayName = top === null
    ? null
    : deps.streamers?.get([top.login]).get(top.login)?.displayName ?? null;
  return {
    day,
    earned: summary.totals.earned,
    minedMs: summary.totals.minedMs,
    dropsClaimed: deps.history.countEvents(["DROP_CLAIM"], from, to).DROP_CLAIM,
    top: top === null ? null : { ...top, displayName },
    hasData: summary.hasData,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/insights/recap.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing scheduler test**

Create `apps/backend/src/notify/sources/digest.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import type { DaySummary } from "../../insights/recap.js";
import { defaultPrefs } from "../prefs.js";
import type { Destination } from "../store.js";
import { DigestScheduler, digestNotification } from "./digest.js";

const summary = (over: Partial<DaySummary> = {}): DaySummary => ({
  day: "2026-09-23", earned: 12_400, minedMs: 6.5 * 3_600_000, dropsClaimed: 2,
  top: { login: "alpha", displayName: "Alpha", earned: 4_100 }, hasData: true, ...over,
});

const dest = (over: Partial<Destination> = {}): Destination => ({
  id: "d1", channel: "webpush", label: "Phone", endpoint: "e", subscription: null,
  prefs: { ...defaultPrefs("Europe/Berlin"), kinds: { "digest.daily": true } },
  enabled: true, createdTs: 1, lastOkTs: null, lastError: null, lastErrorTs: null, ...over,
});

function harness(destinations: Destination[], day = summary()) {
  let now = 0;
  const seen = new Set<string>();
  const sendTo = vi.fn(async () => ({ ok: true as const }));
  const summaryFn = vi.fn(() => day);
  const scheduler = new DigestScheduler({
    notifier: { sendTo, markSeen: (k: string) => (seen.has(k) ? false : (seen.add(k), true)) },
    store: { list: () => destinations },
    summary: summaryFn,
    now: () => now,
  });
  return { scheduler, sendTo, summaryFn, at: (ms: number) => { now = ms; } };
}

test("the digest goes out once a local day, at or after its time", () => {
  const h = harness([dest()]);
  h.at(Date.UTC(2026, 8, 24, 6, 59)); // 08:59 in Berlin
  h.scheduler.tick();
  expect(h.sendTo).not.toHaveBeenCalled();
  h.at(Date.UTC(2026, 8, 24, 7, 0)); // 09:00
  h.scheduler.tick();
  h.at(Date.UTC(2026, 8, 24, 7, 1));
  h.scheduler.tick();
  expect(h.sendTo).toHaveBeenCalledTimes(1);
  expect(h.summaryFn).toHaveBeenCalledWith("2026-09-23");
  h.at(Date.UTC(2026, 8, 25, 7, 0));
  h.scheduler.tick();
  expect(h.sendTo).toHaveBeenCalledTimes(2);
});

test("off, paused or empty means nothing is sent", () => {
  const off = harness([dest({ prefs: defaultPrefs("Europe/Berlin") })]);
  const paused = harness([dest({ enabled: false })]);
  const empty = harness([dest()], summary({ hasData: false }));
  for (const h of [off, paused, empty]) {
    h.at(Date.UTC(2026, 8, 24, 8));
    h.scheduler.tick();
    expect(h.sendTo).not.toHaveBeenCalled();
  }
});

test("the digest reads as one line of figures", () => {
  expect(digestNotification(summary())).toEqual({
    kind: "digest.daily", title: "Yesterday's mining",
    body: "+12.4K points · 2 drops claimed · 6.5 h mined · Top: Alpha +4.1K",
    link: "/?open=insights",
  });
  expect(digestNotification(summary({ dropsClaimed: 0, top: null })).body)
    .toBe("+12.4K points · 6.5 h mined");
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @app/backend exec vitest run src/notify/sources/digest.test.ts`
Expected: FAIL, "Failed to resolve import ./digest.js".

- [ ] **Step 7: Implement it**

Create `apps/backend/src/notify/sources/digest.ts`:

```ts
import { addDays, dayKey } from "../../insights/days.js";
import type { DaySummary } from "../../insights/recap.js";
import { NOTIFY_KIND, type Notification } from "../catalogue.js";
import type { Notifier } from "../notifier.js";
import { kindEnabled, localClock, parseHhmm } from "../prefs.js";
import type { NotifyStore } from "../store.js";

export const DIGEST_TICK_MS = 60_000;

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function digestNotification(s: DaySummary): Omit<Notification, "ts"> {
  const parts = [`+${compact.format(s.earned)} points`];
  if (s.dropsClaimed > 0) parts.push(`${s.dropsClaimed} drop${s.dropsClaimed === 1 ? "" : "s"} claimed`);
  parts.push(`${(s.minedMs / 3_600_000).toFixed(1)} h mined`);
  if (s.top !== null) parts.push(`Top: ${s.top.displayName ?? s.top.login} +${compact.format(s.top.earned)}`);
  return {
    kind: NOTIFY_KIND.DIGEST_DAILY,
    title: "Yesterday's mining",
    body: parts.join(" · "),
    link: "/?open=insights",
  };
}

export interface DigestDeps {
  notifier: Pick<Notifier, "sendTo" | "markSeen">;
  store: Pick<NotifyStore, "list">;
  /** Figures for a server-local day key. */
  summary: (day: string) => DaySummary;
  now?: () => number;
  tickMs?: number;
}

/**
 * Sends each destination its digest once per day in its own time zone,
 * on the first tick at or after its `digestAt`. "Yesterday" is the
 * server's, because that is how daily_points is keyed.
 */
export class DigestScheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DigestDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? DIGEST_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): void {
    const now = this.deps.now ? this.deps.now() : Date.now();
    for (const destination of this.deps.store.list()) {
      const { prefs } = destination;
      if (!destination.enabled || !kindEnabled(prefs, NOTIFY_KIND.DIGEST_DAILY)) continue;
      const local = localClock(now, prefs.timeZone);
      if (local.minutes < parseHhmm(prefs.digestAt)) continue;
      // Claimed before the summary is read, so a quiet day is skipped
      // rather than re-examined every minute until midnight.
      if (!this.deps.notifier.markSeen(`digest:${destination.id}:${local.date}`)) continue;
      const summary = this.deps.summary(addDays(dayKey(now), -1));
      if (!summary.hasData) continue;
      void this.deps.notifier.sendTo(destination, { ...digestNotification(summary), ts: now });
    }
  }
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm --filter @app/backend exec vitest run src/notify/sources/digest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/insights/recap.ts apps/backend/src/insights/recap.test.ts apps/backend/src/notify/sources/digest.*
git commit -m "feat(notify): send an opt-in daily digest at each destination's chosen time" \
  -m "Yesterday's points, drops claimed, hours mined and top streamer, from the same queries as the Insights recap. Each destination gets it once per day in its own time zone; a day with nothing recorded sends nothing." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 13: Wire the pipeline into the backend

**Files:**
- Modify: `apps/backend/src/index.ts`

**Interfaces:**
- Consumes everything from Tasks 1–12. After this task the backend publishes, stores and delivers notifications end to end.

- [ ] **Step 1: Add the imports**

In `apps/backend/src/index.ts`, add with the other imports:

```ts
import { buildDaySummary } from "./insights/recap.js";
import { ActionTokens } from "./notify/actions.js";
import {
  DEFAULT_VAPID_SUBJECT, WebPushChannel, loadOrCreateVapid,
} from "./notify/channels/webPush.js";
import { Notifier } from "./notify/notifier.js";
import { CampaignWatcher, campaignStartedNotification } from "./notify/sources/campaigns.js";
import { DigestScheduler } from "./notify/sources/digest.js";
import { watchDoorbell } from "./notify/sources/doorbell.js";
import { watchHealth } from "./notify/sources/health.js";
import { RestartNotifications } from "./notify/sources/restart.js";
import { watchStreams } from "./notify/sources/streams.js";
import { NotifyStore } from "./notify/store.js";
```

- [ ] **Step 2: Build the notifier next to the database**

Directly after `const dailyPoints = new DailyPoints(db);`, add:

```ts
// Notifications. The key pair lives beside the database: browsers
// subscribe against its public half, so replacing it strands every
// subscription until each browser next opens the app and re-subscribes.
const notifyStore = new NotifyStore(db);
const vapid = loadOrCreateVapid(join(dataDir, "vapid.json"));
const notifier = new Notifier({
  store: notifyStore,
  channels: {
    webpush: new WebPushChannel({
      vapid,
      subject: process.env.VAPID_SUBJECT || DEFAULT_VAPID_SUBJECT,
    }),
  },
  log: appLog.log,
});
const actionTokens = new ActionTokens();
```

In `housekeeping`, add as its first line:

```ts
  notifyStore.prune(Date.now());
```

- [ ] **Step 3: Hand the restart its deferral and transitions**

Replace:

```ts
const pendingRestart = new PendingRestart({ supervisor, log: appLog.log });
```

with:

```ts
// Built in two steps because each needs the other: the notifications
// decide the deferral and hear every transition, and redeeming a
// Cancel action has to reach the pending restart.
let pendingRestartRef: PendingRestart | null = null;
const restartNotes = new RestartNotifications({
  notifier,
  tokens: actionTokens,
  pending: () => pendingRestartRef!,
});
const pendingRestart = new PendingRestart({
  supervisor,
  log: appLog.log,
  deferralMs: () => restartNotes.deferralMs(),
  onTransition: (t) => restartNotes.onTransition(t),
});
pendingRestartRef = pendingRestart;
```

- [ ] **Step 4: Report campaign starts from the engine**

In the `new SubscriptionEngine({...})` call, add after `inventory: inventoryCache,`:

```ts
  onCampaignStarted: (event) => notifier.publish(campaignStartedNotification(event)),
```

- [ ] **Step 5: Attach the sources**

Directly before `const app: AppServer = buildServer({`, add:

```ts
watchHealth({ notifier, supervisor, loginStatus, updates: updateChecker });
watchStreams({ notifier, stateService });
watchDoorbell({ notifier, stateService });
const campaignWatcher = new CampaignWatcher({
  notifier,
  catalogue,
  inventory: inventoryCache,
  subscribedGames: () => loadConfig(configPath).subscriptions
    .filter((s) => s.kind === "game")
    .map((s) => s.targetId),
});
const digest = new DigestScheduler({
  notifier,
  store: notifyStore,
  summary: (day) => buildDaySummary({ history, daily: dailyPoints, streamers }, day, Date.now()),
});
digest.start();
```

- [ ] **Step 6: Give the server its routes**

In the `buildServer({...})` call, add after `engine, pendingRestart,`:

```ts
  notify: {
    store: notifyStore,
    notifier,
    vapidPublicKey: vapid.publicKey,
    redeemAction: (token) => restartNotes.redeem(token),
  },
```

- [ ] **Step 7: Start the campaign watcher after boot, and stop everything at shutdown**

In the boot IIFE, change `engine.start();` to:

```ts
  engine.start();
  campaignWatcher.start();
```

In the signal handler, change `engine.stop();` to:

```ts
      engine.stop();
      campaignWatcher.stop();
      digest.stop();
      notifier.stop();
```

- [ ] **Step 8: Typecheck and run the whole backend suite**

Run: `pnpm run build:backend && pnpm --filter @app/backend test`
Expected: the build succeeds and every test passes.

- [ ] **Step 9: Run the built backend under plain Node**

This is the check Vitest cannot do: a named import from CommonJS `web-push` throws only here.

```bash
export TMC_TMP=$(mktemp -d)
DATA_DIR=$TMC_TMP APP_PASSWORD=pw PORT=8099 PYTHON_BIN=/bin/false STATIC_ROOT=/nonexistent \
  node apps/backend/dist/index.js > $TMC_TMP/out.log 2>&1 &
echo $! > $TMC_TMP/pid
until curl -s localhost:8099/api/status > /dev/null; do sleep 0.5; done
curl -s -c $TMC_TMP/jar -H 'content-type: application/json' -d '{"password":"pw"}' localhost:8099/api/session
curl -s -b $TMC_TMP/jar localhost:8099/api/notify/config | head -c 120; echo
stat -c %a $TMC_TMP/vapid.json
# PYTHON_BIN=/bin/false makes the miner exit at once: an unstartable crash.
curl -s -b $TMC_TMP/jar -X POST localhost:8099/api/miner/start; echo
curl -s -b $TMC_TMP/jar localhost:8099/api/notify/inbox; echo
kill $(cat $TMC_TMP/pid)
```

Expected:
- `/api/notify/config` starts with `{"vapidPublicKey":"B`.
- `vapid.json` is `600`.
- The inbox holds one `miner.crashed` row titled "Miner can't start".
- `out.log` contains `listening on http://localhost:8099` and no `SyntaxError` or `does not provide an export named`.

- [ ] **Step 10: Commit (after the user's go-ahead)**

```bash
git add apps/backend/src/index.ts
git commit -m "feat(notify): wire the notification pipeline into the backend" \
  -m "Builds the store, VAPID keys and notifier beside the database, attaches every source, hands the pending restart its deferral and transitions, mounts the routes, prunes the inbox daily, and stops the watchers at shutdown." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Manifest, icons and the service worker

**Files:**
- Create: `apps/frontend/public/manifest.webmanifest`
- Create: `apps/frontend/public/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`
- Modify: `apps/frontend/index.html`
- Create: `apps/frontend/src/sw/handlers.ts`
- Create: `apps/frontend/src/sw/handlers.test.ts`
- Create: `apps/frontend/src/sw/sw.ts`
- Create: `apps/frontend/vite.sw.config.ts`
- Modify: `apps/frontend/package.json` (`build`, `predev`)
- Modify: `.gitignore`

**Interfaces:**
- Produces, from `sw/handlers.ts`:
  - `interface PushPayload`, which mirrors the backend's
  - `interface SwScope`, `SwClient`, `SwNotification`, `NotificationOptionsLike`, `NotificationData`
  - `ICON = "/icons/icon-192.png"`
  - `parsePayload(raw: string | null): PushPayload | null`, `titleFor(p: PushPayload): string`
  - `onPush(scope: SwScope, raw: string | null): Promise<void>`
  - `onNotificationClick(scope: SwScope, notification: SwNotification, action: string): Promise<void>`
  - `openLink(scope: SwScope, link: string): Promise<void>`
- The worker posts `{ type: "navigate", link: string }` to an open window, and Task 16 listens for it.
- `/sw.js` is served from the app root, scope `/`.

- [ ] **Step 1: Generate the icons**

```bash
mkdir -p apps/frontend/public/icons
cd apps/frontend
convert src/assets/miner-logo.png -resize 192x192 public/icons/icon-192.png
convert src/assets/miner-logo.png -resize 512x512 public/icons/icon-512.png
# Maskable: the logo inside the 80% safe zone on the app background.
convert src/assets/miner-logo.png -resize 410x410 -background '#0E0E10' -gravity center -extent 512x512 public/icons/icon-maskable-512.png
convert src/assets/miner-logo.png -resize 160x160 -background '#0E0E10' -gravity center -extent 180x180 public/icons/apple-touch-icon.png
cd ../..
file apps/frontend/public/icons/*.png
```

Expected: four PNGs at 192, 512, 512 and 180 square.

- [ ] **Step 2: Add the manifest and link it**

Create `apps/frontend/public/manifest.webmanifest`:

```json
{
  "name": "Twitch Miner Control",
  "short_name": "Miner Control",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0E0E10",
  "theme_color": "#18181B",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

In `apps/frontend/index.html`, after the favicon `<link>`, add:

```html
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <meta name="theme-color" content="#18181B" />
```

- [ ] **Step 3: Write the failing handler test**

Create `apps/frontend/src/sw/handlers.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import {
  ICON, onNotificationClick, onPush, type NotificationOptionsLike, type SwClient,
} from "./handlers.js";

function fakeScope(windows: SwClient[] = [], fetchOk = true) {
  const shown: Array<[string, NotificationOptionsLike]> = [];
  const scope = {
    registration: {
      showNotification: vi.fn(async (title: string, options: NotificationOptionsLike) => {
        shown.push([title, options]);
      }),
    },
    clients: {
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => undefined),
    },
    location: { origin: "https://miner.example" },
    fetch: vi.fn(async () => ({ ok: fetchOk })),
  };
  return { scope, shown };
}

const payload = (over: object = {}) => JSON.stringify({
  v: 1, kind: "drop.claimed", title: "Drop claimed", body: "Claim X", link: "/?open=drops",
  ts: 123, urgent: false, ...over,
});

test("a push shows its title and body, keeping the link for a click", async () => {
  const { scope, shown } = fakeScope();
  await onPush(scope, payload());
  expect(shown).toEqual([["Drop claimed", {
    body: "Claim X", icon: ICON, timestamp: 123, requireInteraction: false,
    data: { link: "/?open=drops", actions: [] }, actions: [],
  }]]);
});

test("a tagged push replaces the last one and alerts again", async () => {
  const { scope, shown } = fakeScope();
  await onPush(scope, payload({ tag: "miner-health", urgent: true }));
  expect(shown[0][1]).toMatchObject({ tag: "miner-health", renotify: true, requireInteraction: true });
});

test("a pending restart shows the device's own clock time and a Cancel button", async () => {
  const { scope, shown } = fakeScope();
  const dueAt = Date.UTC(2026, 8, 23, 12, 32);
  await onPush(scope, payload({
    kind: "restart.pending", title: "Miner restart pending", tag: "restart", dueAt,
    actions: [{ action: "cancel-restart", title: "Cancel restart", token: "t".repeat(64) }],
  }));
  const time = new Date(dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  expect(shown[0][0]).toBe(`Miner restarts at ${time}`);
  expect(shown[0][1].actions).toEqual([{ action: "cancel-restart", title: "Cancel restart" }]);
  expect(shown[0][1].data.actions).toEqual([{ action: "cancel-restart", token: "t".repeat(64) }]);
});

test("an unreadable push still shows a notification", async () => {
  const { scope, shown } = fakeScope();
  await onPush(scope, "not json");
  await onPush(scope, null);
  expect(shown).toHaveLength(2);
  expect(shown[0][0]).toBe("Twitch Miner Control");
});

const notification = (data: unknown) => ({ data, close: vi.fn() });
const restartData = {
  link: "/?open=dashboard",
  actions: [{ action: "cancel-restart", token: "t".repeat(64) }],
};

test("Cancel posts the token and replaces the notification", async () => {
  const { scope, shown } = fakeScope();
  const n = notification(restartData);
  await onNotificationClick(scope, n, "cancel-restart");
  expect(n.close).toHaveBeenCalled();
  expect(scope.fetch).toHaveBeenCalledWith("/api/notify/action", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "t".repeat(64) }),
  });
  expect(shown[0]).toEqual(["Restart cancelled", expect.objectContaining({ tag: "restart" })]);
  expect(scope.clients.openWindow).not.toHaveBeenCalled();
});

test("a refused Cancel says so", async () => {
  const { scope, shown } = fakeScope([], false);
  await onNotificationClick(scope, notification(restartData), "cancel-restart");
  expect(shown[0][0]).toBe("Couldn't cancel the restart");
});

test("a click focuses an open window and tells it where to go", async () => {
  const win = { url: "https://miner.example/", focused: false, focus: vi.fn(async () => {}), postMessage: vi.fn() };
  const { scope } = fakeScope([win]);
  await onNotificationClick(scope, notification({ link: "/?open=drops&campaign=c1", actions: [] }), "");
  expect(win.focus).toHaveBeenCalled();
  expect(win.postMessage).toHaveBeenCalledWith({ type: "navigate", link: "/?open=drops&campaign=c1" });
  expect(scope.clients.openWindow).not.toHaveBeenCalled();
});

test("a click with no window open opens one at the link", async () => {
  const { scope } = fakeScope();
  await onNotificationClick(scope, notification({ link: "/?open=logs", actions: [] }), "");
  expect(scope.clients.openWindow).toHaveBeenCalledWith("https://miner.example/?open=logs");
});

test("an outside link opens in a new window", async () => {
  const win = { url: "https://miner.example/", focus: vi.fn(async () => {}), postMessage: vi.fn() };
  const { scope } = fakeScope([win]);
  const link = "https://github.com/vos/twitch-miner-control/releases/tag/v1.6.0";
  await onNotificationClick(scope, notification({ link, actions: [] }), "");
  expect(scope.clients.openWindow).toHaveBeenCalledWith(link);
  expect(win.postMessage).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @app/frontend exec vitest run src/sw/handlers.test.ts`
Expected: FAIL, "Failed to resolve import ./handlers.js".

- [ ] **Step 5: Implement the handlers and the worker entry**

Create `apps/frontend/src/sw/handlers.ts`:

```ts
/**
 * The service worker's behaviour, as plain functions over an injected
 * scope so they run under jsdom. sw.ts binds them to the real worker.
 *
 * Typed against these small interfaces rather than the WebWorker lib,
 * which cannot share a TypeScript program with the DOM lib the app uses.
 */

/** Mirrors PushPayload in apps/backend/src/notify/channels/webPush.ts. */
export interface PushPayload {
  v: 1;
  kind: string;
  title: string;
  body: string;
  link: string;
  ts: number;
  urgent: boolean;
  tag?: string;
  dueAt?: number;
  actions?: Array<{ action: string; title: string; token: string }>;
}

export interface NotificationData {
  link: string;
  actions: Array<{ action: string; token: string }>;
}

export interface NotificationOptionsLike {
  body: string;
  icon: string;
  data: NotificationData;
  tag?: string;
  timestamp?: number;
  requireInteraction?: boolean;
  renotify?: boolean;
  actions?: Array<{ action: string; title: string }>;
}

export interface SwNotification {
  data: unknown;
  close(): void;
}

export interface SwClient {
  url: string;
  focused?: boolean;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface SwScope {
  registration: { showNotification(title: string, options: NotificationOptionsLike): Promise<void> };
  clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly SwClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  location: { origin: string };
  fetch(
    input: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ ok: boolean }>;
}

export const ICON = "/icons/icon-192.png";
const APP_NAME = "Twitch Miner Control";

export function parsePayload(raw: string | null): PushPayload | null {
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as Partial<PushPayload> | null;
    if (p?.v !== 1 || typeof p.title !== "string" || typeof p.body !== "string"
        || typeof p.link !== "string") return null;
    return p as PushPayload;
  } catch {
    return null;
  }
}

/** A pending restart names its time in the device's own clock and locale. */
export function titleFor(p: PushPayload): string {
  if (p.dueAt === undefined) return p.title;
  const time = new Date(p.dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Miner restarts at ${time}`;
}

export async function onPush(scope: SwScope, raw: string | null): Promise<void> {
  const p = parsePayload(raw);
  if (p === null) {
    // Shown regardless: Safari revokes a subscription whose pushes show nothing.
    await scope.registration.showNotification(APP_NAME, {
      body: "Something happened. Open the app for details.",
      icon: ICON,
      data: { link: "/", actions: [] },
    });
    return;
  }
  const actions = p.actions ?? [];
  await scope.registration.showNotification(titleFor(p), {
    body: p.body,
    icon: ICON,
    timestamp: p.ts,
    requireInteraction: p.urgent,
    data: { link: p.link, actions: actions.map(({ action, token }) => ({ action, token })) },
    actions: actions.map(({ action, title }) => ({ action, title })),
    // renotify is only valid with a tag; it makes a replacement alert again.
    ...(p.tag === undefined ? {} : { tag: p.tag, renotify: true }),
  });
}

export async function onNotificationClick(
  scope: SwScope,
  notification: SwNotification,
  action: string,
): Promise<void> {
  const data = notification.data as NotificationData | null;
  notification.close();
  const link = data?.link ?? "/";
  const token = data?.actions.find((a) => a.action === action)?.token;
  if (action === "cancel-restart" && token !== undefined) {
    let ok = false;
    try {
      const res = await scope.fetch("/api/notify/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    await scope.registration.showNotification(
      ok ? "Restart cancelled" : "Couldn't cancel the restart",
      {
        body: ok
          ? "The miner keeps watching the current channels."
          : "It may already have happened. Open the app to check.",
        icon: ICON,
        tag: "restart",
        data: { link, actions: [] },
      },
    );
    return;
  }
  await openLink(scope, link);
}

/** Focuses an open app window and routes it, or opens a new one. */
export async function openLink(scope: SwScope, link: string): Promise<void> {
  const url = new URL(link, scope.location.origin);
  if (url.origin !== scope.location.origin) {
    await scope.clients.openWindow(url.href);
    return;
  }
  const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  const target = windows.find((c) => c.focused === true) ?? windows[0];
  if (target === undefined) {
    await scope.clients.openWindow(url.href);
    return;
  }
  await target.focus();
  target.postMessage({ type: "navigate", link: url.pathname + url.search });
}
```

Create `apps/frontend/src/sw/sw.ts`:

```ts
import { onNotificationClick, onPush, type SwNotification, type SwScope } from "./handlers.js";

interface ExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}
interface PushEvent extends ExtendableEvent {
  data: { text(): string } | null;
}
interface NotificationEvent extends ExtendableEvent {
  notification: SwNotification;
  action: string;
}
interface WorkerScope extends SwScope {
  addEventListener(type: "install" | "activate", listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: "push", listener: (event: PushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: SwScope["clients"] & { claim(): Promise<void> };
}

// `self` is typed for a page here; in the built worker it is the
// ServiceWorkerGlobalScope this interface describes.
const scope = self as unknown as WorkerScope;

// A new version takes over at once rather than waiting for every tab to close.
scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
scope.addEventListener("activate", (event) => event.waitUntil(scope.clients.claim()));
scope.addEventListener("push", (event) => event.waitUntil(onPush(scope, event.data?.text() ?? null)));
scope.addEventListener("notificationclick", (event) =>
  event.waitUntil(onNotificationClick(scope, event.notification, event.action)));
```

- [ ] **Step 6: Run the handler test to verify it passes**

Run: `pnpm --filter @app/frontend exec vitest run src/sw/handlers.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 7: Build the worker as its own script**

Create `apps/frontend/vite.sw.config.ts`:

```ts
import { defineConfig } from "vite";

/**
 * Builds the service worker as one classic script at public/sw.js.
 *
 * Into public/ rather than dist/: the dev server serves public/ as-is,
 * so `pnpm dev` gets a working worker too, and the main build copies it
 * into dist/ with everything else. Unhashed, because the browser finds
 * a worker by its URL. The output is gitignored.
 */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "public",
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: "src/sw/sw.ts",
      formats: ["iife"],
      name: "tmcServiceWorker",
      fileName: () => "sw.js",
    },
  },
});
```

In `apps/frontend/package.json` scripts, change `build` and add `predev`:

```json
    "predev": "vite build -c vite.sw.config.ts",
    "dev": "vite",
    "build": "tsc -b && vite build -c vite.sw.config.ts && vite build",
```

Append to `.gitignore`:

```
apps/frontend/public/sw.js
```

- [ ] **Step 8: Verify both builds**

Run: `pnpm --filter @app/frontend build`
Expected: succeeds. `apps/frontend/public/sw.js` exists and contains `notificationclick`. `apps/frontend/dist/` contains `sw.js`, `manifest.webmanifest` and `icons/`. `git status` does not list `public/sw.js`.

```bash
grep -c notificationclick apps/frontend/public/sw.js
ls apps/frontend/dist/sw.js apps/frontend/dist/manifest.webmanifest apps/frontend/dist/icons/
```

- [ ] **Step 9: Commit (after the user's go-ahead)**

```bash
git add apps/frontend/public/manifest.webmanifest apps/frontend/public/icons apps/frontend/index.html \
  apps/frontend/src/sw apps/frontend/vite.sw.config.ts apps/frontend/package.json .gitignore
git commit -m "feat(ui): add a web app manifest and the push service worker" \
  -m "The manifest makes the app installable, which iOS requires before it allows push at all. The worker shows every push it gets (Safari revokes silent ones), shows a pending restart in the device's own time, carries Cancel restart to the public action endpoint, and routes a click to an open window or opens one. It builds as its own classic script into public/sw.js." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: The notify API client and the push helper

**Files:**
- Create: `apps/frontend/src/api/notify.ts`
- Create: `apps/frontend/src/lib/push.ts`
- Create: `apps/frontend/src/lib/push.test.ts`

**Interfaces:**
- Produces, from `api/notify.ts`: `interface KindInfo { kind; group; label; description; defaultOn }`, `interface NotifyConfig { vapidPublicKey; groups: Array<{ id: string; label: string }>; catalogue: KindInfo[] }`, `interface Prefs`, `interface Destination`, `type DestinationPatch = { label?: string; enabled?: boolean; prefs?: Prefs }`, `interface InboxItem { id; ts; kind; title; body; streamer: string | null; link }`, and `notifyApi` with `config()`, `destinations()`, `register(body)`, `update(id, patch)`, `remove(id)`, `test(id)`, `inbox(before?)`.
- Produces, from `lib/push.ts`: `type PushSupport = "ok" | "insecure" | "ios-install" | "unsupported" | "denied"`, `interface PushEnv`, `readEnv()`, `support(env?)`, `isIos(env)`, `deviceLabel(userAgent)`, `urlBase64ToUint8Array(value)`, `toBase64Url(buffer)`, `class PermissionDeniedError`, `enable(vapidPublicKey): Promise<Destination>`, `currentEndpoint(): Promise<string | null>`, `disable(destinationId: string | null): Promise<void>`, `heal(vapidPublicKey, known): Promise<string | null>`, `healOnStart(): Promise<void>`.

- [ ] **Step 1: Add the API client**

Create `apps/frontend/src/api/notify.ts`:

```ts
import { api } from "./client.js";

export interface KindInfo {
  kind: string;
  group: string;
  label: string;
  description: string;
  defaultOn: boolean;
}

export interface NotifyConfig {
  vapidPublicKey: string;
  groups: Array<{ id: string; label: string }>;
  catalogue: KindInfo[];
}

/** Mirrors prefsSchema in apps/backend/src/notify/prefs.ts. */
export interface Prefs {
  kinds: Partial<Record<string, boolean>>;
  streamers: "all" | string[];
  quietHours: { from: string; to: string; allowHealth: boolean } | null;
  timeZone: string;
  digestAt: string;
}

export interface Destination {
  id: string;
  channel: "webpush";
  label: string;
  endpoint: string | null;
  prefs: Prefs;
  enabled: boolean;
  createdTs: number;
  lastOkTs: number | null;
  lastError: string | null;
  lastErrorTs: number | null;
}

export type DestinationPatch = { label?: string; enabled?: boolean; prefs?: Prefs };

export interface InboxItem {
  id: number;
  ts: number;
  kind: string;
  title: string;
  body: string;
  streamer: string | null;
  link: string;
}

export const notifyApi = {
  config: () => api.get<NotifyConfig>("/api/notify/config"),
  destinations: () => api.get<{ destinations: Destination[] }>("/api/notify/destinations"),
  register: (body: {
    subscription: PushSubscriptionJSON;
    label: string;
    timeZone: string;
    previousEndpoint?: string;
  }) => api.post<{ destination: Destination }>("/api/notify/destinations", body),
  update: (id: string, patch: DestinationPatch) =>
    api.put<{ destination: Destination }>(`/api/notify/destinations/${encodeURIComponent(id)}`, patch),
  remove: (id: string) =>
    api.post<{ ok: true }>(`/api/notify/destinations/${encodeURIComponent(id)}/remove`),
  test: (id: string) =>
    api.post<{ ok: boolean; error?: string }>(`/api/notify/destinations/${encodeURIComponent(id)}/test`),
  inbox: (before?: number) =>
    api.get<{ items?: InboxItem[] }>(`/api/notify/inbox${before === undefined ? "" : `?before=${before}`}`),
};
```

- [ ] **Step 2: Write the failing push test**

Create `apps/frontend/src/lib/push.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  deviceLabel, enable, heal, support, toBase64Url, urlBase64ToUint8Array, type PushEnv,
} from "./push.js";

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  secure: true, serviceWorker: true, pushManager: true, permission: "default",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
  maxTouchPoints: 0, standalone: false, ...over,
});

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1";

test("support explains the first thing in the way", () => {
  expect(support(env({ secure: false }))).toBe("insecure");
  expect(support(env({ userAgent: IPHONE }))).toBe("ios-install");
  expect(support(env({ userAgent: IPHONE, standalone: true }))).toBe("ok");
  expect(support(env({ pushManager: false }))).toBe("unsupported");
  expect(support(env({ permission: null }))).toBe("unsupported");
  expect(support(env({ permission: "denied" }))).toBe("denied");
  expect(support(env())).toBe("ok");
});

test("an iPad asking for the desktop site is still iOS", () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15";
  expect(support(env({ userAgent: ua, maxTouchPoints: 5 }))).toBe("ios-install");
  expect(support(env({ userAgent: ua, maxTouchPoints: 0 }))).toBe("ok");
});

test("a device label names the browser and the platform", () => {
  expect(deviceLabel("Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36")).toBe("Chrome on Android");
  expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0")).toBe("Edge on Windows");
  expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on Linux");
  expect(deviceLabel(IPHONE)).toBe("Safari on iPhone");
});

test("VAPID keys survive the base64url round trip", () => {
  const key = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
  expect(toBase64Url(urlBase64ToUint8Array(key).buffer as ArrayBuffer)).toBe(key);
});

// --- against a fake browser ---

const KEY = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_KEY = "BAhFXcDNbuPtf8RK2Qp_LFaVbSxpJAUht74Fz9W8i7i9QmBlAYmp9OiM9MuEAVHbC62UkgfgXMj9nC-e9YevF84";

function fakeSubscription(endpoint: string, key: string) {
  return {
    endpoint,
    options: { applicationServerKey: urlBase64ToUint8Array(key).buffer },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "p", auth: "a" } }),
  };
}

let posted: Array<{ url: string; body: unknown }>;
let current: ReturnType<typeof fakeSubscription> | null;
let subscribe: ReturnType<typeof vi.fn>;

beforeEach(() => {
  posted = [];
  current = null;
  subscribe = vi.fn(async () => (current = fakeSubscription("https://push.example/new", KEY)));
  const registration = { pushManager: { subscribe, getSubscription: async () => current } };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(async () => registration),
    },
  });
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn(async () => "granted") });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 200, json: async () => ({ destination: { id: "d1", endpoint: current?.endpoint } }) };
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

test("enable asks, subscribes with the server's key and registers this browser", async () => {
  const destination = await enable(KEY);
  expect(destination.id).toBe("d1");
  const options = subscribe.mock.calls[0][0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
  expect(options.userVisibleOnly).toBe(true);
  expect(toBase64Url(options.applicationServerKey.buffer as ArrayBuffer)).toBe(KEY);
  expect(posted[0]).toMatchObject({
    url: "/api/notify/destinations",
    body: {
      subscription: { endpoint: "https://push.example/new" },
      label: expect.any(String),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
});

test("enable stops at a refused permission", async () => {
  vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn(async () => "denied") });
  await expect(enable(KEY)).rejects.toThrow(/blocked/);
  expect(subscribe).not.toHaveBeenCalled();
});

const known = (endpoint: string) => [{ endpoint } as never];

test("heal leaves a healthy subscription alone", async () => {
  current = fakeSubscription("https://push.example/a", KEY);
  expect(await heal(KEY, known("https://push.example/a"))).toBe("https://push.example/a");
  expect(subscribe).not.toHaveBeenCalled();
  expect(posted).toEqual([]);
});

test("heal re-subscribes after the server's key changed, keeping the old row", async () => {
  const old = fakeSubscription("https://push.example/old", OTHER_KEY);
  current = old;
  expect(await heal(KEY, known("https://push.example/old"))).toBe("https://push.example/new");
  expect(old.unsubscribe).toHaveBeenCalled();
  expect(posted[0].body).toMatchObject({ previousEndpoint: "https://push.example/old" });
});

test("heal respects a removal made from another device", async () => {
  const sub = fakeSubscription("https://push.example/a", KEY);
  current = sub;
  expect(await heal(KEY, [])).toBeNull();
  expect(sub.unsubscribe).toHaveBeenCalled();
  expect(posted).toEqual([]);
});

test("heal does nothing where push was never turned on", async () => {
  expect(await heal(KEY, [])).toBeNull();
  expect(subscribe).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @app/frontend exec vitest run src/lib/push.test.ts`
Expected: FAIL, "Failed to resolve import ./push.js".

- [ ] **Step 4: Implement the helper**

Create `apps/frontend/src/lib/push.ts`:

```ts
import { notifyApi, type Destination } from "../api/notify.js";

export type PushSupport = "ok" | "insecure" | "ios-install" | "unsupported" | "denied";

/** What decides whether this browser can receive push. */
export interface PushEnv {
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  /** Null when the Notification API is missing entirely. */
  permission: NotificationPermission | null;
  userAgent: string;
  maxTouchPoints: number;
  /** Opened from the Home Screen, which iOS requires for push. */
  standalone: boolean;
}

export function readEnv(): PushEnv {
  return {
    secure: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    permission: typeof Notification === "undefined" ? null : Notification.permission,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: window.matchMedia("(display-mode: standalone)").matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  };
}

/** An iPad asking for the desktop site reports itself as a Mac with a touch screen. */
export function isIos(env: Pick<PushEnv, "userAgent" | "maxTouchPoints">): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent)
    || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}

/** The first thing standing in the way, in the order a user can fix them. */
export function support(env: PushEnv = readEnv()): PushSupport {
  if (!env.secure) return "insecure";
  if (isIos(env) && !env.standalone) return "ios-install";
  if (!env.serviceWorker || !env.pushManager || env.permission === null) return "unsupported";
  if (env.permission === "denied") return "denied";
  return "ok";
}

/** A starting name for this browser; the user can rename it. */
export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const platform = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "this device";
  return `${browser} on ${platform}`;
}

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function toBase64Url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class PermissionDeniedError extends Error {
  constructor() {
    super("Notifications are blocked for this site. Allow them in the browser's site settings.");
  }
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

async function existingSubscription(): Promise<{
  reg: ServiceWorkerRegistration;
  sub: PushSubscription;
} | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return reg === undefined || sub == null ? null : { reg, sub };
}

const subscribeWith = (reg: ServiceWorkerRegistration, key: string) =>
  reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });

/**
 * Turns push on for this browser. Call it straight from the click
 * handler: iOS and Firefox only show the permission prompt for a gesture.
 */
export async function enable(vapidPublicKey: string): Promise<Destination> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PermissionDeniedError();
  const reg = await registration();
  const sub = await subscribeWith(reg, vapidPublicKey);
  const { destination } = await notifyApi.register({
    subscription: sub.toJSON(),
    label: deviceLabel(navigator.userAgent),
    timeZone: timeZone(),
  });
  return destination;
}

/** This browser's push endpoint, which is how it finds its own row. */
export async function currentEndpoint(): Promise<string | null> {
  return (await existingSubscription())?.sub.endpoint ?? null;
}

export async function disable(destinationId: string | null): Promise<void> {
  await (await existingSubscription())?.sub.unsubscribe();
  if (destinationId !== null) await notifyApi.remove(destinationId);
}

/**
 * Brings this browser's subscription back in line with the server.
 *
 * - Same key, and the server knows it: nothing to do.
 * - Same key, and the server does not: removed from another device, so
 *   unsubscribe here too rather than quietly re-registering.
 * - Different key: vapid.json was replaced. Re-subscribe, and name the
 *   old endpoint so the row keeps its label and preferences.
 *
 * Returns this browser's endpoint while push is on here, else null.
 */
export async function heal(
  vapidPublicKey: string,
  known: readonly Pick<Destination, "endpoint">[],
): Promise<string | null> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
  const existing = await existingSubscription();
  if (existing === null) return null;
  const { reg, sub } = existing;
  const key = sub.options.applicationServerKey;
  const sameKey = key !== null && toBase64Url(key) === vapidPublicKey;
  if (sameKey && known.some((d) => d.endpoint === sub.endpoint)) return sub.endpoint;
  await sub.unsubscribe();
  if (sameKey) return null;
  const fresh = await subscribeWith(reg, vapidPublicKey);
  await notifyApi.register({
    subscription: fresh.toJSON(),
    label: deviceLabel(navigator.userAgent),
    timeZone: timeZone(),
    previousEndpoint: sub.endpoint,
  });
  return fresh.endpoint;
}

/** heal() on app start, where a failure just waits for the next visit. */
export async function healOnStart(): Promise<void> {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const [config, { destinations }] = await Promise.all([
      notifyApi.config(), notifyApi.destinations(),
    ]);
    await heal(config.vapidPublicKey, destinations);
  } catch {
    // Retried on the next visit.
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @app/frontend exec vitest run src/lib/push.test.ts && pnpm --filter @app/frontend exec tsc -b`
Expected: PASS (10 tests), and the typecheck is clean. `urlBase64ToUint8Array` returns `Uint8Array<ArrayBuffer>` because `applicationServerKey` takes a `BufferSource`, which a plain `Uint8Array` (backed by `ArrayBufferLike`) does not satisfy.

- [ ] **Step 6: Commit (after the user's go-ahead)**

```bash
git add apps/frontend/src/api/notify.ts apps/frontend/src/lib/push.ts apps/frontend/src/lib/push.test.ts
git commit -m "feat(ui): add the push helper that subscribes and heals this browser" \
  -m "support() names the first thing in the way (no HTTPS, iOS outside the Home Screen, no Push API, blocked). enable() subscribes with the server's VAPID key from inside the click; heal() runs on every start and re-subscribes after a key change, keeping the row, while a removal made on another device is respected." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Deep links, worker messages and healing on start

**Files:**
- Create: `apps/frontend/src/lib/deepLink.ts`
- Create: `apps/frontend/src/lib/deepLink.test.ts`
- Modify: `apps/frontend/src/app.tsx` (`App`, `Shell`)
- Modify: `apps/frontend/src/app.test.tsx` (append)

**Interfaces:**
- Consumes: `healOnStart` (Task 15); the worker's `{ type: "navigate", link }` message (Task 14); `ScreenParams` from `lib/screenIntent.ts`.
- Produces: `interface LinkTarget { screen: string; params?: ScreenParams; streamer?: string }`, `isExternal(link)`, `parseLink(link): LinkTarget | null`, `clearBootLink()`. `Shell` gains `openLink(link: string)`, which Task 18's bell uses.

- [ ] **Step 1: Write the failing parser test**

Create `apps/frontend/src/lib/deepLink.test.ts`:

```ts
import { expect, test } from "vitest";
import { isExternal, parseLink } from "./deepLink.js";

test("a link names a screen and its params", () => {
  expect(parseLink("/?open=drops&campaign=c1")).toEqual({ screen: "drops", params: { campaign: "c1" } });
  expect(parseLink("?open=insights&period=week")).toEqual({ screen: "insights", params: { period: "week" } });
  expect(parseLink("/?open=dashboard&streamer=alpha")).toEqual({ screen: "dashboard", streamer: "alpha" });
  expect(parseLink("/?open=logs")).toEqual({ screen: "logs" });
});

test("anything else is not an app link", () => {
  expect(parseLink("/")).toBeNull();
  expect(parseLink("")).toBeNull();
  expect(parseLink("https://github.com/vos/twitch-miner-control?open=drops")).toBeNull();
  expect(parseLink("/?open=insights&period=year")).toEqual({ screen: "insights" });
});

test("absolute http links are external", () => {
  expect(isExternal("https://github.com/x")).toBe(true);
  expect(isExternal("/?open=drops")).toBe(false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend exec vitest run src/lib/deepLink.test.ts`
Expected: FAIL, "Failed to resolve import ./deepLink.js".

- [ ] **Step 3: Implement the parser**

Create `apps/frontend/src/lib/deepLink.ts`:

```ts
import type { ScreenParams } from "./screenIntent.js";

/**
 * Where a notification points inside the app: `/?open=<screen>&...`.
 * The screen name is checked by the shell, which knows which exist.
 */
export interface LinkTarget {
  screen: string;
  params?: ScreenParams;
  /** Opens that streamer's detail dialog over the screen. */
  streamer?: string;
}

export function isExternal(link: string): boolean {
  return /^https?:\/\//i.test(link);
}

export function parseLink(link: string): LinkTarget | null {
  if (isExternal(link)) return null;
  let url: URL;
  try {
    url = new URL(link, "http://app.invalid");
  } catch {
    return null;
  }
  const screen = url.searchParams.get("open");
  if (!screen) return null;
  const params: ScreenParams = {};
  const campaign = url.searchParams.get("campaign");
  if (campaign) params.campaign = campaign;
  const period = url.searchParams.get("period");
  if (period === "week" || period === "month") params.period = period;
  const streamer = url.searchParams.get("streamer");
  return {
    screen,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    ...(streamer ? { streamer } : {}),
  };
}

/** Drops the `?open=` link from the address bar once it has been followed. */
export function clearBootLink(): void {
  window.history.replaceState(null, "", window.location.pathname + window.location.hash);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @app/frontend exec vitest run src/lib/deepLink.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing app tests**

Append to `apps/frontend/src/app.test.tsx`:

```ts
// --- notification links ---

test("a notification link opens its screen and leaves the address bar clean", async () => {
  window.history.replaceState(null, "", "/?open=logs");
  stub(false);
  view();
  await waitFor(() => expect(screen.getByTestId("screen-title")).toHaveTextContent("Logs"));
  expect(window.location.search).toBe("");
});

test("the service worker can send an open app to a screen", async () => {
  // A holder rather than a `let`: TypeScript would narrow a `let` to its
  // initial null, not seeing the assignment inside the callback.
  const heard: { listener?: (event: MessageEvent) => void } = {};
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      addEventListener: (_: string, fn: (event: MessageEvent) => void) => { heard.listener = fn; },
      removeEventListener: () => {},
    },
  });
  try {
    stub(false);
    view();
    await screen.findByTestId("screen-title");
    act(() => heard.listener!({ data: { type: "navigate", link: "/?open=logs" } } as MessageEvent));
    expect(screen.getByTestId("screen-title")).toHaveTextContent("Logs");
  } finally {
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  }
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @app/frontend exec vitest run src/app.test.tsx`
Expected: the two new tests FAIL. The title stays "Dashboard".

- [ ] **Step 7: Follow links in the shell**

In `apps/frontend/src/app.tsx`:

1. Add imports:

```ts
import { clearBootLink, isExternal, parseLink, type LinkTarget } from "./lib/deepLink.js";
import { healOnStart } from "./lib/push.js";
```

2. Replace `App` with:

```tsx
export function App() {
  // Read once, before the gate: a notification can open the app while
  // the session has expired, and the link still applies after unlocking.
  const [bootLink] = useState(() => parseLink(window.location.search));
  return (
    <PasswordGate>
      <LiveStateProvider>
        <Shell bootLink={bootLink} />
      </LiveStateProvider>
    </PasswordGate>
  );
}
```

3. Change `function Shell() {` to `function Shell({ bootLink }: { bootLink: LinkTarget | null }) {`.

4. After the `navigate` function inside `Shell`, add:

```tsx
  const follow = (target: LinkTarget) => {
    if (!(target.screen in SCREENS)) return;
    navigate(target.screen as ScreenKey, target.params);
    if (target.streamer !== undefined) setOpenLogin(target.streamer);
  };

  /** Follows a notification's link: an app screen, or an outside page in a new tab. */
  const openLink = (link: string) => {
    if (isExternal(link)) {
      window.open(link, "_blank", "noopener,noreferrer");
      return;
    }
    const target = parseLink(link);
    if (target !== null) follow(target);
  };
  // The effects below attach once, so they read the latest of both
  // through a ref.
  const links = useRef({ follow, openLink });
  links.current = { follow, openLink };

  useEffect(() => {
    if (bootLink === null) return;
    clearBootLink();
    links.current.follow(bootLink);
  }, [bootLink]);

  useEffect(() => {
    // Absent outside a secure context, whatever the DOM types say.
    if (!("serviceWorker" in navigator)) return;
    const worker = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; link?: unknown } | null;
      if (data?.type === "navigate" && typeof data.link === "string") links.current.openLink(data.link);
    };
    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, []);

  // Keeps this browser's push subscription matched to the server's key.
  useEffect(() => { void healOnStart(); }, []);
```

- [ ] **Step 8: Run the app tests to verify they pass**

Run: `pnpm --filter @app/frontend exec vitest run src/app.test.tsx src/lib/ && pnpm --filter @app/frontend exec tsc -b`
Expected: PASS, including every existing test, and the typecheck is clean.

- [ ] **Step 9: Commit (after the user's go-ahead)**

```bash
git add apps/frontend/src/lib/deepLink.ts apps/frontend/src/lib/deepLink.test.ts apps/frontend/src/app.tsx apps/frontend/src/app.test.tsx
git commit -m "feat(ui): open the screen a notification points at" \
  -m "A /?open= link is read before the password gate and followed after it, then removed from the address bar. An open window follows the service worker's navigate message instead of opening a second tab, and every start heals this browser's push subscription." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 17: The Notifications screen

**Files:**
- Create: `apps/frontend/src/components/notify/TestButton.tsx`
- Create: `apps/frontend/src/components/notify/ThisBrowserCard.tsx`
- Create: `apps/frontend/src/components/notify/PrefsEditor.tsx`
- Create: `apps/frontend/src/components/notify/DestinationList.tsx`
- Create: `apps/frontend/src/routes/Notifications.tsx`
- Create: `apps/frontend/src/routes/Notifications.test.tsx`
- Modify: `apps/frontend/src/app.tsx` (`SCREENS`)
- Modify: `apps/frontend/src/components/Sidebar.tsx` (`ITEMS`), `components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `notifyApi` and its types (Task 15); `support`, `enable`, `disable`, `currentEndpoint`, `PushSupport` (Task 15); `useLiveState` for the roster; `formatSpan` from `lib/formatSpan.ts`.
- Produces: the `notifications` screen key (its label is "Notifications"), which Task 18's bell navigates to, and `/?open=notifications` links reach.

- [ ] **Step 1: Write the failing screen test**

Create `apps/frontend/src/routes/Notifications.test.tsx`:

```tsx
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as push from "../lib/push.js";
import { renderLive } from "../test-utils.js";
import { Notifications } from "./Notifications.js";

vi.mock("../lib/push.js", () => ({
  support: vi.fn(() => "ok"),
  enable: vi.fn(),
  disable: vi.fn(async () => {}),
  currentEndpoint: vi.fn(async () => null),
}));

const config = {
  vapidPublicKey: "BKey",
  groups: [{ id: "health", label: "Miner health" }, { id: "streamers", label: "Streamers" }],
  catalogue: [
    { kind: "miner.crashed", group: "health", label: "Miner crashed", description: "d", defaultOn: true },
    { kind: "streamer.online", group: "streamers", label: "Streamer online", description: "d", defaultOn: false },
  ],
};
const prefs = { kinds: {}, streamers: "all", quietHours: null, timeZone: "Europe/Berlin", digestAt: "09:00" };
const dest = (id: string, over: object = {}) => ({
  id, channel: "webpush", label: `Device ${id}`, endpoint: `https://push.example/${id}`,
  prefs, enabled: true, createdTs: 1, lastOkTs: null, lastError: null, lastErrorTs: null, ...over,
});

let calls: Array<{ url: string; init?: RequestInit }>;
let destinations: ReturnType<typeof dest>[];

class FakeEventSource {
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  calls = [];
  destinations = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url === "/api/notify/config") return json(config);
    if (url === "/api/notify/destinations") return json({ destinations });
    if (url === "/api/streamers") {
      return json({ streamers: [{ username: "alpha", displayName: "Alpha" }], lastUpdated: null, stale: true, error: null });
    }
    if (init?.method === "PUT") {
      const id = url.split("/").pop();
      return json({ destination: { ...destinations.find((d) => d.id === id), ...JSON.parse(String(init.body)) } });
    }
    return json({ ok: true });
  }));
  vi.mocked(push.support).mockReturnValue("ok");
  vi.mocked(push.currentEndpoint).mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

const view = () => renderLive(<Notifications />);
const sent = (url: string) => {
  const body = calls.find((c) => c.url === url && c.init?.method !== undefined && c.init.method !== "GET")
    ?.init?.body;
  return body === undefined || body === null ? undefined : JSON.parse(String(body));
};

test("without HTTPS the card explains why and offers nothing to press", async () => {
  vi.mocked(push.support).mockReturnValue("insecure");
  view();
  expect(await screen.findByText(/need HTTPS/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /reverse proxy/ }))
    .toHaveAttribute("href", expect.stringContaining("#putting-it-behind-a-reverse-proxy"));
  expect(screen.queryByRole("button", { name: "Turn on notifications" })).toBeNull();
});

test("on an iPhone outside the Home Screen it says how to install", async () => {
  vi.mocked(push.support).mockReturnValue("ios-install");
  view();
  expect(await screen.findByText(/Add to Home Screen/)).toBeInTheDocument();
});

test("turning on registers this browser and shows its events", async () => {
  vi.mocked(push.enable).mockResolvedValue(dest("me") as never);
  view();
  await userEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
  expect(push.enable).toHaveBeenCalledWith("BKey");
  expect(await screen.findByText("Events for this browser")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Miner crashed" })).toBeChecked();
  expect(screen.getByRole("switch", { name: "Streamer online" })).not.toBeChecked();
});

test("a refused permission is shown", async () => {
  vi.mocked(push.enable).mockRejectedValue(new Error("Notifications are blocked for this site."));
  view();
  await userEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
  expect(await screen.findByText(/blocked for this site/)).toBeInTheDocument();
});

test("toggling an event saves this browser's preferences", async () => {
  destinations = [dest("me")];
  vi.mocked(push.currentEndpoint).mockResolvedValue("https://push.example/me");
  view();
  await userEvent.click(await screen.findByRole("switch", { name: "Streamer online" }));
  await waitFor(() => expect(sent("/api/notify/destinations/me")?.prefs.kinds).toEqual({ "streamer.online": true }));
});

test("the streamer filter narrows to chosen streamers", async () => {
  destinations = [dest("me")];
  vi.mocked(push.currentEndpoint).mockResolvedValue("https://push.example/me");
  view();
  await userEvent.click(await screen.findByText("Only these"));
  await waitFor(() => expect(sent("/api/notify/destinations/me")?.prefs.streamers).toEqual([]));
});

test("other devices are listed with their state, and can be removed", async () => {
  destinations = [dest("me"), dest("d2", { lastError: "push service answered 500" })];
  vi.mocked(push.currentEndpoint).mockResolvedValue("https://push.example/me");
  view();
  const row = await screen.findByTestId("destination-d2");
  expect(within(row).getByText("Last delivery failed: push service answered 500")).toBeInTheDocument();
  await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(screen.queryByTestId("destination-d2")).toBeNull());
  expect(calls.some((c) => c.url === "/api/notify/destinations/d2/remove")).toBe(true);
});

test("editing another device's events switches the editor to it", async () => {
  destinations = [dest("me"), dest("d2")];
  vi.mocked(push.currentEndpoint).mockResolvedValue("https://push.example/me");
  view();
  await userEvent.click(within(await screen.findByTestId("destination-d2")).getByRole("button", { name: "Edit events" }));
  expect(await screen.findByText("Events for Device d2")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend exec vitest run src/routes/Notifications.test.tsx`
Expected: FAIL, "Failed to resolve import ./Notifications.js".

- [ ] **Step 3: Implement the components**

Create `apps/frontend/src/components/notify/TestButton.tsx`:

```tsx
import { Button, Group, Text } from "@mantine/core";
import { useState } from "react";

type State = { kind: "idle" | "sending" | "sent" } | { kind: "failed"; error: string };

/** Sends a test notification and says how it went. `onTest` resolves with an error, or null. */
export function TestButton({ onTest, size = "sm" }: {
  onTest: () => Promise<string | null>;
  size?: "xs" | "sm";
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  return (
    <Group gap="xs">
      <Button
        size={size}
        variant="default"
        loading={state.kind === "sending"}
        onClick={async () => {
          setState({ kind: "sending" });
          const error = await onTest();
          setState(error === null ? { kind: "sent" } : { kind: "failed", error });
        }}
      >
        Send test
      </Button>
      {state.kind === "sent" && <Text size="sm" c="dimmed">Sent</Text>}
      {state.kind === "failed" && <Text size="sm" c="red">{state.error}</Text>}
    </Group>
  );
}
```

Create `apps/frontend/src/components/notify/ThisBrowserCard.tsx`:

```tsx
import { Anchor, Badge, Button, Card, Group, Stack, Text, TextInput, Title } from "@mantine/core";
import type { ReactNode } from "react";
import type { Destination, DestinationPatch } from "../../api/notify.js";
import type { PushSupport } from "../../lib/push.js";
import { TestButton } from "./TestButton.js";

const HTTPS_HELP = "https://github.com/vos/twitch-miner-control#putting-it-behind-a-reverse-proxy";

/** What stands in the way, in words the user can act on. */
const BLOCKERS: Record<Exclude<PushSupport, "ok">, ReactNode> = {
  insecure: (
    <>
      Browser notifications need HTTPS, or the app opened on localhost.{" "}
      <Anchor href={HTTPS_HELP} target="_blank" rel="noopener noreferrer">
        Set up HTTPS with a reverse proxy
      </Anchor>
      . The bell's inbox works either way.
    </>
  ),
  "ios-install": (
    <>
      On iPhone and iPad, notifications only work once the app is on the Home Screen. Tap Share,
      then Add to Home Screen, and open it from there.
    </>
  ),
  unsupported: <>This browser can't receive push notifications. The bell's inbox still works.</>,
  denied: (
    <>
      Notifications are blocked for this site. Allow them in the browser's site settings, then
      reload this page.
    </>
  ),
};

export function ThisBrowserCard({
  support, destination, busy, onTurnOn, onTurnOff, onSave, onTest,
}: {
  support: PushSupport;
  destination: Destination | null;
  busy: boolean;
  onTurnOn: () => void;
  onTurnOff: () => void;
  onSave: (patch: DestinationPatch) => void;
  onTest: () => Promise<string | null>;
}) {
  return (
    <Card withBorder>
      <Stack gap="sm">
        <Group justify="space-between">
          <Title order={4}>This browser</Title>
          {destination !== null && (
            <Badge variant="light" color={destination.enabled ? "green" : "gray"}>
              {destination.enabled ? "On" : "Paused"}
            </Badge>
          )}
        </Group>
        {support !== "ok" && <Text size="sm" c="dimmed">{BLOCKERS[support]}</Text>}
        {destination === null && support === "ok" && (
          <>
            <Text size="sm">
              Get notified about crashes, drops and restarts even with this tab closed. Once it's on,
              choose which events below.
            </Text>
            <Group>
              <Button onClick={onTurnOn} loading={busy}>Turn on notifications</Button>
            </Group>
          </>
        )}
        {destination !== null && (
          <>
            <TextInput
              label="Name"
              description="How this browser is listed on your other devices."
              defaultValue={destination.label}
              maxLength={60}
              onBlur={(event) => {
                const label = event.currentTarget.value.trim();
                if (label !== "" && label !== destination.label) onSave({ label });
              }}
            />
            <Group>
              <Button variant="default" onClick={() => onSave({ enabled: !destination.enabled })}>
                {destination.enabled ? "Pause" : "Resume"}
              </Button>
              <TestButton onTest={onTest} />
              <Button variant="subtle" color="red" onClick={onTurnOff} loading={busy}>Turn off</Button>
            </Group>
            {destination.lastError !== null && (
              <Text size="sm" c="red">Last delivery failed: {destination.lastError}</Text>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}
```

Create `apps/frontend/src/components/notify/PrefsEditor.tsx`:

```tsx
import {
  Card, Checkbox, Group, MultiSelect, SegmentedControl, Stack, Switch, Text, TextInput, Title,
} from "@mantine/core";
import type { KindInfo, NotifyConfig, Prefs } from "../../api/notify.js";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIGEST = "digest.daily";

type Change = (prefs: Prefs) => void;

/** One destination's choices. Every change is saved as it is made. */
export function PrefsEditor({ config, heading, prefs, roster, onChange }: {
  config: NotifyConfig;
  heading: string;
  prefs: Prefs;
  /** Streamers to offer for the "went live" filter. */
  roster: Array<{ value: string; label: string }>;
  onChange: Change;
}) {
  const on = (k: Pick<KindInfo, "kind" | "defaultOn">) => prefs.kinds[k.kind] ?? k.defaultOn;
  const setKind = (kind: string, value: boolean) =>
    onChange({ ...prefs, kinds: { ...prefs.kinds, [kind]: value } });
  const digest = config.catalogue.find((k) => k.kind === DIGEST);

  return (
    <Card withBorder>
      <Stack gap="md">
        <Title order={4}>{heading}</Title>
        {config.groups.map((group) => {
          const kinds = config.catalogue.filter((k) => k.group === group.id);
          if (kinds.length === 0) return null;
          return (
            <Stack key={group.id} gap="xs">
              <Text fw={600} size="sm">{group.label}</Text>
              {kinds.map((k) => (
                <Switch
                  key={k.kind}
                  label={k.label}
                  description={k.description}
                  checked={on(k)}
                  onChange={(event) => setKind(k.kind, event.currentTarget.checked)}
                />
              ))}
              {group.id === "streamers" && (
                <StreamerFilter prefs={prefs} roster={roster} onChange={onChange} />
              )}
              {group.id === "digest" && digest !== undefined && on(digest) && (
                <TextInput
                  type="time"
                  label="Send at"
                  w={140}
                  pl="xl"
                  defaultValue={prefs.digestAt}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (TIME.test(value)) onChange({ ...prefs, digestAt: value });
                  }}
                />
              )}
            </Stack>
          );
        })}
        <QuietHoursField prefs={prefs} onChange={onChange} />
        <Text size="xs" c="dimmed">Times are in {prefs.timeZone}.</Text>
      </Stack>
    </Card>
  );
}

function StreamerFilter({ prefs, roster, onChange }: {
  prefs: Prefs;
  roster: Array<{ value: string; label: string }>;
  onChange: Change;
}) {
  const chosen = prefs.streamers === "all" ? null : prefs.streamers;
  // A chosen streamer no longer in the roster still shows, so it can be removed.
  const data = chosen === null ? roster : [
    ...roster,
    ...chosen.filter((login) => !roster.some((r) => r.value === login))
      .map((login) => ({ value: login, label: login })),
  ];
  return (
    <Stack gap="xs" pl="xl">
      <SegmentedControl
        size="xs"
        w="fit-content"
        value={chosen === null ? "all" : "some"}
        data={[{ value: "all", label: "All streamers" }, { value: "some", label: "Only these" }]}
        onChange={(value) => onChange({ ...prefs, streamers: value === "all" ? "all" : [] })}
      />
      {chosen !== null && (
        <MultiSelect
          aria-label="Streamers to notify about"
          placeholder="Pick streamers"
          searchable
          data={data}
          value={chosen}
          onChange={(logins) => onChange({ ...prefs, streamers: logins })}
        />
      )}
    </Stack>
  );
}

function QuietHoursField({ prefs, onChange }: { prefs: Prefs; onChange: Change }) {
  const quiet = prefs.quietHours;
  return (
    <Stack gap="xs">
      <Switch
        label="Quiet hours"
        description="Nothing is sent in this window. The inbox still records everything."
        checked={quiet !== null}
        onChange={(event) => onChange({
          ...prefs,
          quietHours: event.currentTarget.checked
            ? { from: "22:00", to: "07:00", allowHealth: true }
            : null,
        })}
      />
      {quiet !== null && (
        <Group pl="xl" align="flex-end">
          <TextInput
            type="time" label="From" w={120} defaultValue={quiet.from}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (TIME.test(value)) onChange({ ...prefs, quietHours: { ...quiet, from: value } });
            }}
          />
          <TextInput
            type="time" label="To" w={120} defaultValue={quiet.to}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (TIME.test(value)) onChange({ ...prefs, quietHours: { ...quiet, to: value } });
            }}
          />
          <Checkbox
            label="Let miner problems through"
            checked={quiet.allowHealth}
            onChange={(event) => onChange({
              ...prefs, quietHours: { ...quiet, allowHealth: event.currentTarget.checked },
            })}
          />
        </Group>
      )}
    </Stack>
  );
}
```

Create `apps/frontend/src/components/notify/DestinationList.tsx`:

```tsx
import { Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import type { Destination } from "../../api/notify.js";
import { formatSpan } from "../../lib/formatSpan.js";
import { TestButton } from "./TestButton.js";

function status(d: Destination, now: number): { text: string; error: boolean } {
  if (d.lastError !== null) return { text: `Last delivery failed: ${d.lastError}`, error: true };
  if (d.lastOkTs !== null) return { text: `Last delivered ${formatSpan(now - d.lastOkTs)} ago`, error: false };
  return { text: "Nothing delivered yet", error: false };
}

/** Every destination other than this browser. */
export function DestinationList({
  destinations, selectedId, onSelect, onTest, onToggle, onRemove,
}: {
  destinations: Destination[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onTest: (id: string) => Promise<string | null>;
  onToggle: (destination: Destination) => void;
  onRemove: (id: string) => void;
}) {
  const now = Date.now();
  return (
    <Card withBorder>
      <Stack gap="md">
        <Title order={4}>Other devices</Title>
        {destinations.length === 0 && (
          <Text size="sm" c="dimmed">
            No other browser has notifications on. Open this page on another device to turn them on
            there.
          </Text>
        )}
        {destinations.map((d) => {
          const s = status(d, now);
          return (
            <Stack key={d.id} gap={4} data-testid={`destination-${d.id}`}>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs">
                  <Text fw={600}>{d.label}</Text>
                  {!d.enabled && <Badge variant="light" color="gray">Paused</Badge>}
                </Group>
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="xs"
                    variant={d.id === selectedId ? "filled" : "default"}
                    onClick={() => onSelect(d.id)}
                  >
                    Edit events
                  </Button>
                  <Button size="xs" variant="default" onClick={() => onToggle(d)}>
                    {d.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button size="xs" variant="subtle" color="red" onClick={() => onRemove(d.id)}>
                    Remove
                  </Button>
                </Group>
              </Group>
              <Group gap="xs">
                <Text size="sm" c={s.error ? "red" : "dimmed"}>{s.text}</Text>
                <TestButton size="xs" onTest={() => onTest(d.id)} />
              </Group>
            </Stack>
          );
        })}
      </Stack>
    </Card>
  );
}
```

- [ ] **Step 4: Implement the screen**

Create `apps/frontend/src/routes/Notifications.tsx`:

```tsx
import { Alert, Center, Loader, Stack } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import {
  notifyApi, type Destination, type DestinationPatch, type NotifyConfig,
} from "../api/notify.js";
import { useLiveState } from "../api/useLiveState.js";
import { DestinationList } from "../components/notify/DestinationList.js";
import { PrefsEditor } from "../components/notify/PrefsEditor.js";
import { ThisBrowserCard } from "../components/notify/ThisBrowserCard.js";
import { currentEndpoint, disable, enable, support, type PushSupport } from "../lib/push.js";

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function Notifications() {
  const { snapshot } = useLiveState();
  const [config, setConfig] = useState<NotifyConfig | null>(null);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  // This browser's push endpoint, which is how it finds its own row.
  const [here, setHere] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pushSupport, setPushSupport] = useState<PushSupport>(() => support());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [c, d, endpoint] = await Promise.all([
      notifyApi.config(), notifyApi.destinations(), currentEndpoint(),
    ]);
    setConfig(c);
    setDestinations(d.destinations);
    setHere(endpoint);
  }, []);

  useEffect(() => {
    reload().catch((cause) => setError(messageOf(cause)));
  }, [reload]);

  const mine = here === null ? null : destinations.find((d) => d.endpoint === here) ?? null;
  const others = destinations.filter((d) => d.id !== mine?.id);
  const selected = destinations.find((d) => d.id === selectedId) ?? mine ?? others[0] ?? null;
  const roster = (snapshot?.streamers ?? []).map((s) => ({
    value: s.username, label: s.displayName ?? s.username,
  }));

  const save = async (id: string, patch: DestinationPatch) => {
    // Shown at once; the server's answer replaces it.
    setDestinations((all) => all.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    try {
      const { destination } = await notifyApi.update(id, patch);
      setDestinations((all) => all.map((d) => (d.id === id ? destination : d)));
    } catch (cause) {
      setError(messageOf(cause));
      void reload().catch(() => undefined);
    }
  };

  const turnOn = async () => {
    if (config === null) return;
    setBusy(true);
    setError(null);
    try {
      const destination = await enable(config.vapidPublicKey);
      setHere(destination.endpoint);
      setDestinations((all) => [...all.filter((d) => d.id !== destination.id), destination]);
      setSelectedId(destination.id);
    } catch (cause) {
      setError(messageOf(cause));
      setPushSupport(support());
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      await disable(mine?.id ?? null);
      setDestinations((all) => all.filter((d) => d.id !== mine?.id));
      setHere(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await notifyApi.remove(id);
      setDestinations((all) => all.filter((d) => d.id !== id));
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const test = async (id: string): Promise<string | null> => {
    try {
      const result = await notifyApi.test(id);
      return result.ok ? null : result.error ?? "The test could not be delivered.";
    } catch (cause) {
      return messageOf(cause);
    }
  };

  if (config === null) {
    return error === null
      ? <Center py="xl" role="status" aria-label="Loading notifications"><Loader size="sm" /></Center>
      : <Alert color="red">{error}</Alert>;
  }

  return (
    <Stack maw={760} gap="lg">
      {error !== null && (
        <Alert color="red" withCloseButton closeButtonLabel="Dismiss" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <ThisBrowserCard
        support={pushSupport}
        destination={mine}
        busy={busy}
        onTurnOn={() => void turnOn()}
        onTurnOff={() => void turnOff()}
        onSave={(patch) => { if (mine !== null) void save(mine.id, patch); }}
        onTest={() => (mine === null ? Promise.resolve(null) : test(mine.id))}
      />
      {selected !== null && (
        <PrefsEditor
          key={selected.id}
          config={config}
          heading={selected.id === mine?.id ? "Events for this browser" : `Events for ${selected.label}`}
          prefs={selected.prefs}
          roster={roster}
          onChange={(prefs) => void save(selected.id, { prefs })}
        />
      )}
      <DestinationList
        destinations={others}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedId}
        onTest={test}
        onToggle={(d) => void save(d.id, { enabled: !d.enabled })}
        onRemove={(id) => void remove(id)}
      />
    </Stack>
  );
}
```

- [ ] **Step 5: Register the screen and its nav entry**

In `apps/frontend/src/app.tsx`, import `import { Notifications } from "./routes/Notifications.js";` and add to `SCREENS` after `settings`:

```tsx
  notifications: { label: "Notifications", element: () => <Notifications /> },
```

In `apps/frontend/src/components/Sidebar.tsx`, add `IconBell` to the `@tabler/icons-react` import and add to `ITEMS` after the Settings entry:

```tsx
  { key: "notifications", label: "Notifications", icon: <IconBell {...ICON} /> },
```

In `apps/frontend/src/components/Sidebar.test.tsx`, add `"Notifications"` after `"Settings"` in the list inside "every screen the app defines is reachable from the nav".

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @app/frontend exec vitest run src/routes/Notifications.test.tsx src/components/Sidebar.test.tsx src/app.test.tsx && pnpm --filter @app/frontend exec tsc -b`
Expected: PASS, and the typecheck is clean.

- [ ] **Step 7: Commit (after the user's go-ahead)**

```bash
git add apps/frontend/src/components/notify apps/frontend/src/routes/Notifications.tsx \
  apps/frontend/src/routes/Notifications.test.tsx apps/frontend/src/app.tsx \
  apps/frontend/src/components/Sidebar.tsx apps/frontend/src/components/Sidebar.test.tsx
git commit -m "feat(ui): add the Notifications screen with per-device preferences" \
  -m "This browser: why push is unavailable when it is (no HTTPS, iOS outside the Home Screen, blocked), or turn on, rename, pause, test and turn off. Below it, the selected destination's events by group, a streamer filter for going live, quiet hours with miner problems let through, and the digest time; then every other device with its last delivery, test, pause and remove." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 18: The bell and the inbox drawer

**Files:**
- Create: `apps/frontend/src/components/NotificationBell.tsx`
- Create: `apps/frontend/src/components/NotificationBell.test.tsx`
- Modify: `apps/frontend/src/app.tsx` (header)

**Interfaces:**
- Consumes: `notifyApi.inbox`, `InboxItem` (Task 15); `useStreamEvent` from `api/useLiveState.ts`; the SSE `notification` event (Task 7); `Shell`'s `openLink` (Task 16); the `notifications` screen (Task 17).
- Produces: `NotificationBell({ onOpenLink: (link: string) => void; onOpenSettings: () => void })`, and the `localStorage` key `tw.notify.lastSeenId`.

- [ ] **Step 1: Write the failing test**

Create `apps/frontend/src/components/NotificationBell.test.tsx`:

```tsx
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderLive } from "../test-utils.js";
import { NotificationBell } from "./NotificationBell.js";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  handlers = new Map<string, (event: MessageEvent) => void>();
  constructor() { FakeEventSource.last = this; }
  addEventListener(type: string, handler: (event: MessageEvent) => void) { this.handlers.set(type, handler); }
  close() {}
  push(type: string, data: unknown) {
    act(() => this.handlers.get(type)?.({ data: JSON.stringify(data) } as MessageEvent));
  }
}

const item = (id: number, title = `Item ${id}`) => ({
  id, ts: Date.now() - 60_000, kind: "drop.claimed", title, body: `Body ${id}`, streamer: null,
  link: `/?open=drops&campaign=c${id}`,
});

let inbox: ReturnType<typeof item>[];
let calls: string[];

beforeEach(() => {
  inbox = [item(3), item(2), item(1)];
  calls = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const body = url.startsWith("/api/notify/inbox")
      ? { items: url.includes("before=") ? [item(0, "Older")] : inbox }
      : { streamers: [], lastUpdated: null, stale: true, error: null };
    return { ok: true, status: 200, json: async () => body };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const view = (onOpenLink = vi.fn(), onOpenSettings = vi.fn()) => {
  renderLive(<NotificationBell onOpenLink={onOpenLink} onOpenSettings={onOpenSettings} />);
  return { onOpenLink, onOpenSettings };
};

test("a first visit starts with nothing unread", async () => {
  view();
  await waitFor(() => expect(localStorage.getItem("tw.notify.lastSeenId")).toBe("3"));
  expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
});

test("rows newer than the last seen count as unread, and pushed ones add to it", async () => {
  localStorage.setItem("tw.notify.lastSeenId", "1");
  view();
  expect(await screen.findByRole("button", { name: "Notifications, 2 unread" })).toBeInTheDocument();
  await waitFor(() => expect(FakeEventSource.last).not.toBeNull());
  FakeEventSource.last!.push("notification", item(4, "Pushed"));
  expect(await screen.findByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
});

test("opening the drawer lists the inbox and clears the count", async () => {
  localStorage.setItem("tw.notify.lastSeenId", "1");
  view();
  await userEvent.click(await screen.findByRole("button", { name: "Notifications, 2 unread" }));
  expect(await screen.findByText("Item 3")).toBeInTheDocument();
  expect(screen.getByText("Body 2")).toBeInTheDocument();
  expect(localStorage.getItem("tw.notify.lastSeenId")).toBe("3");
});

test("a row opens its link", async () => {
  const { onOpenLink } = view();
  await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  await userEvent.click(await screen.findByText("Item 2"));
  expect(onOpenLink).toHaveBeenCalledWith("/?open=drops&campaign=c2");
});

test("a full page offers the next one", async () => {
  inbox = Array.from({ length: 50 }, (_, i) => item(100 - i));
  view();
  await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  await userEvent.click(await screen.findByRole("button", { name: "Load more" }));
  expect(await screen.findByText("Older")).toBeInTheDocument();
  expect(calls).toContain("/api/notify/inbox?before=51");
});

test("an empty inbox says what will appear, and links to the settings", async () => {
  inbox = [];
  const { onOpenSettings } = view();
  await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
  expect(await screen.findByText(/Nothing yet/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Notification settings" }));
  expect(onOpenSettings).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @app/frontend exec vitest run src/components/NotificationBell.test.tsx`
Expected: FAIL, "Failed to resolve import ./NotificationBell.js".

- [ ] **Step 3: Implement the bell**

Create `apps/frontend/src/components/NotificationBell.tsx`:

```tsx
import {
  ActionIcon, Button, Drawer, Indicator, Stack, Text, Tooltip, UnstyledButton,
} from "@mantine/core";
import { IconBell } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { notifyApi, type InboxItem } from "../api/notify.js";
import { useStreamEvent } from "../api/useLiveState.js";
import { formatSpan } from "../lib/formatSpan.js";

const SEEN_KEY = "tw.notify.lastSeenId";
/** Matches the server's default page size. */
const PAGE = 50;

// Guarded: private mode throws on access, and a badge is never worth the page.
function readSeen(): number | null {
  try {
    const stored = localStorage.getItem(SEEN_KEY);
    return stored === null ? null : Number(stored);
  } catch {
    return null;
  }
}

function writeSeen(id: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(id));
  } catch {
    // The count just resets next visit.
  }
}

/**
 * The inbox: what happened while nobody was looking. Unread is kept per
 * browser, as "newer than the last id this browser has seen".
 */
export function NotificationBell({ onOpenLink, onOpenSettings }: {
  onOpenLink: (link: string) => void;
  onOpenSettings: () => void;
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [more, setMore] = useState(false);
  const [seen, setSeen] = useState<number | null>(readSeen);
  const [opened, setOpened] = useState(false);

  const markSeen = (list: InboxItem[]) => {
    const top = list[0]?.id;
    if (top === undefined) return;
    writeSeen(top);
    setSeen(top);
  };

  useEffect(() => {
    notifyApi.inbox()
      .then(({ items: page = [] }) => {
        setItems(page);
        setMore(page.length === PAGE);
        // A browser's first visit starts clean rather than badging the
        // whole history.
        if (readSeen() === null) {
          writeSeen(page[0]?.id ?? 0);
          setSeen(page[0]?.id ?? 0);
        }
      })
      .catch(() => undefined);
  }, []);

  useStreamEvent<InboxItem>("notification", (row) => {
    setItems((prev) => [row, ...prev.filter((i) => i.id !== row.id)]);
  });

  const unread = seen === null ? 0 : items.filter((i) => i.id > seen).length;

  const open = () => {
    setOpened(true);
    markSeen(items);
  };
  const close = () => {
    setOpened(false);
    // Anything that arrived while it was open has been seen too.
    markSeen(items);
  };

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (last === undefined) return;
    const { items: page = [] } = await notifyApi.inbox(last.id);
    setItems((prev) => [...prev, ...page]);
    setMore(page.length === PAGE);
  };

  const now = Date.now();
  return (
    <>
      <Tooltip label="Notifications">
        <Indicator label={unread > 99 ? "99+" : unread} size={16} offset={4} disabled={unread === 0}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
            onClick={open}
          >
            <IconBell size={20} stroke={1.7} />
          </ActionIcon>
        </Indicator>
      </Tooltip>
      <Drawer opened={opened} onClose={close} position="right" size="sm" title="Notifications">
        <Stack gap="xs">
          {items.length === 0 && (
            <Text size="sm" c="dimmed">
              Nothing yet. Miner problems, restarts, drops and updates show up here.
            </Text>
          )}
          {items.map((item) => (
            <UnstyledButton
              key={item.id}
              onClick={() => {
                close();
                onOpenLink(item.link);
              }}
              p="xs"
              style={{ borderRadius: 8, border: "1px solid var(--tw-border)" }}
            >
              <Text fw={600} size="sm">{item.title}</Text>
              <Text size="sm" c="dimmed">{item.body}</Text>
              <Text size="xs" c="dimmed">{formatSpan(now - item.ts)} ago</Text>
            </UnstyledButton>
          ))}
          {more && <Button variant="subtle" onClick={() => void loadMore()}>Load more</Button>}
          <Button
            variant="light"
            onClick={() => {
              close();
              onOpenSettings();
            }}
          >
            Notification settings
          </Button>
        </Stack>
      </Drawer>
    </>
  );
}
```

- [ ] **Step 4: Put it in the header**

In `apps/frontend/src/app.tsx`, import `import { NotificationBell } from "./components/NotificationBell.js";` and, in the header's right-hand `<Group gap="sm" wrap="nowrap">`, add before `<PaletteButton />`:

```tsx
            <NotificationBell
              onOpenLink={openLink}
              onOpenSettings={() => navigate("notifications")}
            />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @app/frontend exec vitest run src/components/NotificationBell.test.tsx src/app.test.tsx && pnpm --filter @app/frontend exec tsc -b`
Expected: PASS. The existing app tests keep passing because their generic fetch stub answers the inbox with an object that has no `items`, which reads as an empty inbox. If a Drawer query misses its content during the open transition, query it with `{ hidden: true }`.

- [ ] **Step 6: Commit (after the user's go-ahead)**

```bash
git add apps/frontend/src/components/NotificationBell.tsx apps/frontend/src/components/NotificationBell.test.tsx apps/frontend/src/app.tsx
git commit -m "feat(ui): add the notification bell and its inbox drawer" \
  -m "The header bell counts inbox rows newer than the last one this browser has seen and grows as new ones are pushed over SSE. The drawer lists them newest first with paging; a row opens its link, and the footer leads to the Notifications screen. A browser's first visit starts with nothing unread." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Documentation, full verification and a look in the browser

**Files:**
- Modify: `README.md` (the `### Notifications` section)
- Modify: `.env.example`

- [ ] **Step 1: Rewrite the README section**

In `README.md`, replace the `### Notifications` heading and its first paragraph (from `### Notifications` up to and including `password over plain HTTP on your LAN. Set them by hand instead.`) with the text below. Keep everything after it (the `run.py` instructions and the compose mount) unchanged under the new `####` heading.

```markdown
### Notifications

The **bell** in the header is an inbox of what happened while you were
away: miner crashes, an expired Twitch session, restarts, drops claimed,
campaigns completed or about to end, and new releases. It needs no setup.

**Browser notifications** reach you with the app closed. Open
**Notifications** in the sidebar and press **Turn on notifications** in
each browser you want them in. Nothing is sent until you do. Every
browser has its own settings: which events, which streamers count for
"went live", quiet hours (with miner problems optionally let through),
and an optional daily digest.

Browsers only allow this on a secure page:

- over **HTTPS**, so put the app behind a reverse proxy (see
  [Putting it behind a reverse proxy](#putting-it-behind-a-reverse-proxy)), or
- on **localhost**, opened on the machine the app runs on.
- On **iPhone and iPad** (iOS 16.4 or later), add the app to the Home
  Screen first (Share → Add to Home Screen), then turn notifications on
  from there.

Chrome and Edge put a **Cancel restart** button on the restart notice. In
Firefox and Safari, click the notice to open the dashboard, which has the
same button. While any browser is set to receive restart notices, the
drops engine waits three minutes before restarting instead of one.

Notifications are delivered through your browser maker's push service
(Google, Mozilla or Apple), so the app needs outbound internet access.
They are end-to-end encrypted, and the push service cannot read them. The
app's key pair is `data/vapid.json`. If it is deleted, each browser
re-subscribes the next time it opens the app.

#### Other services: Telegram, Discord, Matrix, Pushover, Gotify, webhooks

The miner itself can also push its own events to these. They are
deliberately **not** configurable from the web UI: they carry bot tokens
and webhook URLs, and this app serves a single shared password, over
plain HTTP unless you add a proxy. Set them by hand instead.
```

- [ ] **Step 2: Document the one new variable**

Append to `.env.example`:

```bash

# Contact sent to browser push services with every notification: a
# mailto: or https: URL. Defaults to this project's GitHub URL, because
# Apple's push service rejects a mailto: at localhost.
# VAPID_SUBJECT=mailto:you@example.com
```

- [ ] **Step 3: Run everything**

Run: `pnpm test && pnpm -r build`
Expected: every backend and frontend test passes, and both packages build. `apps/frontend/dist/sw.js` exists.

- [ ] **Step 4: Look at it in the browser**

Serve the production build on `localhost`, which counts as a secure context:

```bash
export TMC_TMP=$(mktemp -d)
DATA_DIR=$TMC_TMP APP_PASSWORD=pw PORT=8099 PYTHON_BIN=/bin/false STATIC_ROOT=apps/frontend/dist \
  node apps/backend/dist/index.js > $TMC_TMP/out.log 2>&1 &
echo $! > $TMC_TMP/pid
until curl -s localhost:8099/api/status > /dev/null; do sleep 0.5; done
```

With Playwright's Chromium (see the "Driving the app with Playwright" memory: authenticate with `POST /api/session`, nav rows are buttons, routing is client-side):

1. Open `http://localhost:8099/`. Click **Notifications** in the sidebar. Screenshot the screen: the "This browser" card offers **Turn on notifications**, and "Other devices" is empty.
2. Grant the `notifications` permission to the context and press the button. Playwright's Chromium has no Google API keys, so `pushManager.subscribe` fails. Confirm the failure appears as the red alert, not as a blank screen or an uncaught error. Screenshot it.
3. `POST /api/miner/start` with the session cookie. The `/bin/false` miner exits at once. Confirm the bell shows **1 unread**, open the drawer, and screenshot the "Miner can't start" row. Click it: the screen title becomes "Logs".
4. Open `http://localhost:8099/?open=drops`. The Drops screen shows, and the address bar reads `/`.
5. `kill $(cat $TMC_TMP/pid)`.

Send the screenshots to the user with SendUserFile (Read shows an image only to you).

- [ ] **Step 5: Hand over for device testing**

Real delivery cannot be tested in the container. Ask the user to check these behind their HTTPS proxy:

- Desktop Chrome or Edge: turn on, **Send test**, close the tab, then trigger a restart (subscribe to a drop campaign) and press **Cancel restart** on the notice. The dashboard banner disappears, and the notice changes to "Restart cancelled".
- Android Chrome: the same, with the phone locked.
- Firefox: a click on the notice opens the dashboard.
- iPhone or iPad: add to the Home Screen, turn on from there, **Send test**.
- A second device appears under "Other devices" and can be paused, tested and removed from the first.

- [ ] **Step 6: Commit (after the user's go-ahead)**

```bash
git add README.md .env.example
git commit -m "docs: explain the inbox and browser notifications" \
  -m "What the bell shows, how to turn browser notifications on per device, why they need HTTPS or localhost (and the Home Screen on iOS), which browsers get the Cancel restart button, and that delivery goes through the browser maker's push service, end-to-end encrypted. The manual miner integrations stay documented under Other services." \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| Event catalogue (all 19 kinds, defaults, inbox, urgency, TTL) | 1 |
| Per-device prefs: kinds, streamer filter, quiet hours in own zone, allowHealth, digest time | 1, 17 |
| Storage: three tables, retention, VAPID file 0600, `VAPID_SUBJECT` | 2, 6, 13, 19 |
| Pipeline: publish never throws, inbox + SSE, fan-out, dedupe, follow-ups by tag | 4, 7 |
| Batching (10 s, summaries) | 3, 4 |
| Miner health: crashed (tagged), recovered, signed out (transition only), update (once per version) | 8 |
| Restart: pending with Cancel, device-local time, follow-ups, TTL 90 s, 3-minute deferral | 9, 14 |
| Action tokens: single-use, bound to one restart, public endpoint, logged with `via` | 5, 7, 9 |
| Streamer online (fresh, restart-proof) / offline (in-process) | 10 |
| Doorbell kinds | 10 |
| Campaign completed / ending soon / new / started | 11 |
| Daily digest | 12 |
| Delivery status mapping, retry, 410 deletes | 6, 4 |
| App log entries under `COMPONENT.NOTIFY` | 4, 7 |
| Deep links through the password gate; worker `navigate` message | 16 |
| Service worker: always shows, Cancel, focus-or-open; `sw.js` no-cache | 14, 7 |
| Manifest and icons for iOS | 14 |
| Push helper: support states, enable from a gesture, self-healing | 15, 16 |
| Notifications screen | 17 |
| Bell and drawer | 18 |
| README | 19 |
| Phase 2 (ntfy, Telegram, `PUBLIC_URL`) | out of scope |
