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
