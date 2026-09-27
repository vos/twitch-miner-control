import { addDays, dayKey } from "../../insights/days.js";
import type { DaySummary } from "../../insights/recap.js";
import type { GiftSub } from "../../state/giftSubs.js";
import { NOTIFY_KIND, type Notification } from "../catalogue.js";
import type { Notifier } from "../notifier.js";
import { kindEnabled, localClock, parseHhmm } from "../prefs.js";
import type { Destination, NotifyStore } from "../store.js";

export const DIGEST_TICK_MS = 60_000;

const HOUR_MS = 3_600_000;

/** How close to its end a gift sub must be for the morning reminder. */
export const GIFT_ENDING_WINDOW_MS = 72 * HOUR_MS;

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

/** "in 2d", or hours in the last two days, where days would round to nothing. */
function timeLeft(ms: number): string {
  return ms >= 48 * HOUR_MS
    ? `${Math.round(ms / (24 * HOUR_MS))}d`
    : `${Math.max(1, Math.round(ms / HOUR_MS))}h`;
}

function giftLine(g: GiftSub, now: number): string {
  const left = `ends in ${timeLeft(g.endsAt - now)}`;
  if (g.target === null) return `${g.product} gift ${left}`;
  const tier = typeof g.tier === "number" ? `Tier ${g.tier} gift sub` : `${g.product} gift`;
  const from = g.gifter === null ? "" : ` from ${g.gifter.displayName}`;
  return `${g.target.displayName}: ${tier}${from} ${left}`;
}

export function giftEndingNotification(gifts: GiftSub[], now: number): Omit<Notification, "ts"> {
  return {
    kind: NOTIFY_KIND.GIFT_ENDING_SOON,
    title: gifts.length === 1 ? "Gift sub ending soon" : `${gifts.length} gift subs ending soon`,
    body: gifts.map((g) => giftLine(g, now)).join(" · "),
    link: "/?open=dashboard",
  };
}

export interface DigestDeps {
  notifier: Pick<Notifier, "sendTo" | "markSeen">;
  store: Pick<NotifyStore, "list">;
  /** Figures for a server-local day key. */
  summary: (day: string) => DaySummary;
  /** The account's active gift subs, for the ending-soon reminder. Absent, none is sent. */
  giftSubs?: () => GiftSub[];
  now?: () => number;
  tickMs?: number;
}

/**
 * Sends each destination its digest once per day in its own time zone,
 * on the first tick at or after its `digestAt`. "Yesterday" is the
 * server's, because that is how daily_points is keyed.
 *
 * The gift-ending reminder rides the same clock but is its own kind, on
 * by default where the digest is not, so it is checked independently.
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
      if (!destination.enabled) continue;
      const { prefs } = destination;
      const local = localClock(now, prefs.timeZone);
      const sinceDigest = local.minutes - parseHhmm(prefs.digestAt);
      if (sinceDigest < 0) continue;
      this.digest(destination, local.date, now);
      this.giftsEnding(destination, now - sinceDigest * 60_000, now);
    }
  }

  private digest(destination: Destination, date: string, now: number): void {
    if (!kindEnabled(destination.prefs, NOTIFY_KIND.DIGEST_DAILY)) return;
    // Claimed before the summary is read, so a quiet day is skipped
    // rather than re-examined every minute until midnight.
    if (!this.deps.notifier.markSeen(`digest:${destination.id}:${date}`)) return;
    const summary = this.deps.summary(addDays(dayKey(now), -1));
    if (!summary.hasData) return;
    void this.deps.notifier.sendTo(destination, { ...digestNotification(summary), ts: now });
  }

  /**
   * Every gift inside the window as of this morning's digest time, each
   * announced once per destination.
   *
   * The window is measured from the digest moment rather than from now,
   * so the set due is fixed for the day: a gift that crosses the three-day
   * mark in the afternoon waits for tomorrow's digest instead of pinging
   * at whatever minute it crossed.
   */
  private giftsEnding(destination: Destination, digestMoment: number, now: number): void {
    if (!kindEnabled(destination.prefs, NOTIFY_KIND.GIFT_ENDING_SOON)) return;
    const due = (this.deps.giftSubs?.() ?? []).filter((g) =>
      g.endsAt > now && g.endsAt - digestMoment <= GIFT_ENDING_WINDOW_MS
      && this.deps.notifier.markSeen(`gift.endingSoon:${destination.id}:${g.id}`));
    if (due.length === 0) return;
    void this.deps.notifier.sendTo(destination, { ...giftEndingNotification(due, now), ts: now });
  }
}
