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
