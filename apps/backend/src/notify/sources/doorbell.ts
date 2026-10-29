import type { EventEmitter } from "node:events";
import { NOTIFY_KIND, type NotifyKind } from "../catalogue.js";
import type { Notifier } from "../notifier.js";

/** The miner's Events worth a notification, by doorbell type. */
export const DOORBELL_KINDS: ReadonlyMap<string, { kind: NotifyKind; title: string; link: string }> = new Map([
  ["DROP_CLAIM", { kind: NOTIFY_KIND.DROP_CLAIMED, title: "Drop claimed", link: "/?open=drops" }],
  ["PREDICTION_WIN", { kind: NOTIFY_KIND.PREDICTION_WON, title: "Prediction won", link: "/?open=dashboard" }],
  ["PREDICTION_LOSE", { kind: NOTIFY_KIND.PREDICTION_LOST, title: "Prediction lost", link: "/?open=dashboard" }],
  ["GAIN_FOR_WATCH_STREAK", { kind: NOTIFY_KIND.STREAK_EARNED, title: "Watch streak bonus", link: "/?open=dashboard" }],
  ["JOIN_RAID", { kind: NOTIFY_KIND.RAID_JOINED, title: "Raid joined", link: "/?open=dashboard" }],
  ["CHAT_MENTION", { kind: NOTIFY_KIND.CHAT_MENTION, title: "Mentioned in chat", link: "/?open=dashboard" }],
  ["GIFT_SUB_RECEIVED", { kind: NOTIFY_KIND.GIFT_RECEIVED, title: "Gift sub received", link: "/?open=dashboard" }],
]);

/**
 * The least time between two error notifications. Upstream reports every
 * failed Twitch request, and an outage fails them all.
 */
export const ERROR_NOTIFY_EVERY_MS = 3_600_000;

/**
 * Publishes from the feed rows the doorbell records. The body is the
 * miner's own wording, which names the streamer; see
 * python/helpers/doorbell.py.
 */
export function watchDoorbell(deps: {
  notifier: Pick<Notifier, "publish">;
  stateService: Pick<EventEmitter, "on">;
  now?: () => number;
}): void {
  let lastErrorAt: number | null = null;
  let heldBack = 0;
  deps.stateService.on("event", (row: { type: string; message: string | null }) => {
    if (row.type === "ERROR") {
      const at = deps.now?.() ?? Date.now();
      if (lastErrorAt !== null && at - lastErrorAt < ERROR_NOTIFY_EVERY_MS) {
        heldBack += 1;
        return;
      }
      const more = lastErrorAt !== null && heldBack > 0
        ? ` (${heldBack} more since the last notice)`
        : "";
      lastErrorAt = at;
      heldBack = 0;
      deps.notifier.publish({
        kind: NOTIFY_KIND.MINER_ERROR,
        title: "Miner error",
        body: `${row.message ?? "The miner reported an error."}${more}`,
        link: "/?open=logs",
        tag: "miner-error",
      });
      return;
    }
    const mapped = DOORBELL_KINDS.get(row.type);
    if (mapped === undefined) return;
    deps.notifier.publish({
      kind: mapped.kind, title: mapped.title, body: row.message ?? mapped.title, link: mapped.link,
    });
  });
}
