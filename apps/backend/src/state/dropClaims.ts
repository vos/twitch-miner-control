import type { EventEmitter } from "node:events";
import type { DropClaim, History } from "../db/history.js";
import { NOTIFY_KIND } from "../notify/catalogue.js";
import type { Notifier } from "../notify/notifier.js";

/**
 * How long after a claim attempt to reread the inventory. The miner's event
 * goes out before its request, and Twitch needs a moment to record the claim.
 */
export const CLAIM_VERIFY_DELAY_MS = 15_000;

/**
 * Stores the claims Twitch reports and announces the new ones.
 *
 * The first sync of a fresh store takes in every reward ever earned, none
 * of which is news.
 */
export function syncClaims(
  deps: { history: Pick<History, "hasClaims" | "recordClaims">; notifier: Pick<Notifier, "publish"> },
  claims: readonly DropClaim[],
): void {
  const backlog = !deps.history.hasClaims();
  const fresh = deps.history.recordClaims(claims);
  if (backlog) return;
  for (const claim of fresh) {
    deps.notifier.publish({
      kind: NOTIFY_KIND.DROP_CLAIMED, title: "Drop claimed", body: claim.name, link: "/?open=drops",
    });
  }
}

/** Rereads the inventory after a claim attempt, which is what settles it. */
export function verifyClaimAttempts(deps: {
  stateService: Pick<EventEmitter, "on">;
  inventory: { refresh(): Promise<unknown> };
}): void {
  let timer: NodeJS.Timeout | null = null;
  deps.stateService.on("event", (row: { type: string }) => {
    if (row.type !== "DROP_CLAIM" || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void deps.inventory.refresh();
    }, CLAIM_VERIFY_DELAY_MS);
  });
}
