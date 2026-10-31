import type { EventEmitter } from "node:events";
import { NOTIFY_KIND, type NotifyKind } from "../catalogue.js";
import type { Notifier } from "../notifier.js";

/** The miner's Events worth a notification, by doorbell type. */
export const DOORBELL_KINDS: ReadonlyMap<string, { kind: NotifyKind; title: string; link: string }> = new Map([
  ["PREDICTION_WIN", { kind: NOTIFY_KIND.PREDICTION_WON, title: "Prediction won", link: "/?open=dashboard" }],
  ["PREDICTION_LOSE", { kind: NOTIFY_KIND.PREDICTION_LOST, title: "Prediction lost", link: "/?open=dashboard" }],
  ["GAIN_FOR_WATCH_STREAK", { kind: NOTIFY_KIND.STREAK_EARNED, title: "Watch streak bonus", link: "/?open=dashboard" }],
  ["JOIN_RAID", { kind: NOTIFY_KIND.RAID_JOINED, title: "Raid joined", link: "/?open=dashboard" }],
  ["CHAT_MENTION", { kind: NOTIFY_KIND.CHAT_MENTION, title: "Mentioned in chat", link: "/?open=dashboard" }],
  ["GIFT_SUB_RECEIVED", { kind: NOTIFY_KIND.GIFT_RECEIVED, title: "Gift sub received", link: "/?open=dashboard" }],
]);

/**
 * The least time between two error notifications from one part of the
 * miner. Upstream reports every failed Twitch request, and an outage fails
 * them all, which must not use up the notice a rarer failure would get.
 */
export const ERROR_NOTIFY_EVERY_MS = 3_600_000;

/**
 * The least time between two notices of one prediction failure. Twitch
 * gives the same refusal on every bet until its cause is dealt with.
 */
export const PREDICTION_FAILED_NOTIFY_EVERY_MS = 86_400_000;

/** What to do about the refusals that have a fix, by Twitch's error code. */
const PREDICTION_FAILURE_ADVICE: ReadonlyMap<string, string> = new Map([
  ["MUST_ACCEPT_TOS",
    "Twitch wants this account to accept its predictions terms. Place one prediction by hand on twitch.tv."],
]);

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
  const errorSources = new Map<string, { lastAt: number; heldBack: number }>();
  const failureNoticeAt = new Map<string, number>();
  deps.stateService.on("event", (row: {
    type: string; message: string | null; errorCode?: string; context?: string;
  }) => {
    if (row.type === "PREDICTION_FAILED") {
      const code = row.errorCode ?? "UNKNOWN";
      const at = deps.now?.() ?? Date.now();
      const last = failureNoticeAt.get(code);
      if (last !== undefined && at - last < PREDICTION_FAILED_NOTIFY_EVERY_MS) return;
      failureNoticeAt.set(code, at);
      deps.notifier.publish({
        kind: NOTIFY_KIND.PREDICTION_FAILED,
        title: "Prediction failed",
        body: PREDICTION_FAILURE_ADVICE.get(code)
          ?? `${row.message ?? "Twitch refused a prediction."} (${code})`,
        link: "/?open=dashboard",
        tag: `prediction-failed-${code}`,
      });
      return;
    }
    if (row.type === "ERROR") {
      const at = deps.now?.() ?? Date.now();
      const source = errorSources.get(row.context ?? "");
      if (source !== undefined && at - source.lastAt < ERROR_NOTIFY_EVERY_MS) {
        source.heldBack += 1;
        return;
      }
      const more = source !== undefined && source.heldBack > 0
        ? ` (${source.heldBack} more since the last notice)`
        : "";
      errorSources.set(row.context ?? "", { lastAt: at, heldBack: 0 });
      deps.notifier.publish({
        kind: NOTIFY_KIND.MINER_ERROR,
        title: "Miner error",
        body: `${row.message ?? "The miner reported an error."}${more}`,
        link: "/?open=logs",
        tag: row.context === undefined ? "miner-error" : `miner-error:${row.context}`,
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
