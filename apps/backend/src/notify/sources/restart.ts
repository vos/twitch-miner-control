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
