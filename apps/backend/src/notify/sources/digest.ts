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
