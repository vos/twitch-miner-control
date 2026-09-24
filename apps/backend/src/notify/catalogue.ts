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
    defaultOn: true, inbox: true, urgency: "high", ttlSeconds: 180, batch: false },
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
