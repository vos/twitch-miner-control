import type { Subscription } from "../config/schema.js";
import type { Campaign } from "../state/campaignCatalogue.js";

/**
 * Where a campaign subscription stands in the one-at-a-time queue.
 *
 * `scheduled` waits like `waiting` does, but is told apart because it is
 * waiting on its campaign opening rather than on its turn: it is passed
 * over, not queued behind, and takes the slot back by rank once open.
 */
export type QueueState = "active" | "waiting" | "scheduled";

export interface QueueEntry {
  state: QueueState;
  /** 1-based place among the waiting and scheduled; 0 for the active one. */
  position: number;
}

/**
 * Which campaign subscription is collected now, and which wait.
 *
 * The active one is the lowest-ranked campaign subscription whose
 * campaign is open. A scheduled campaign is skipped rather than holding
 * the slot, since watching cannot start it; one missing from the
 * catalogue counts as open, because a failed fetch must not stall the
 * queue. `done` names subscriptions leaving on this pass (ended or
 * complete) so the next one takes over at once. Game subscriptions are
 * not queued and get no entry.
 */
export function campaignQueue(
  /** In rank order. */
  subs: readonly Subscription[],
  campaignOf: (sub: Subscription) => Campaign | undefined,
  now: number,
  done: ReadonlySet<string> = new Set(),
): Map<string, QueueEntry> {
  const queue = new Map<string, QueueEntry>();
  let active = false;
  let position = 0;
  for (const sub of subs) {
    if (sub.kind !== "campaign" || done.has(sub.id)) continue;
    const startsAt = campaignOf(sub)?.startsAt;
    if (startsAt != null && startsAt > now) {
      queue.set(sub.id, { state: "scheduled", position: ++position });
    } else if (!active) {
      active = true;
      queue.set(sub.id, { state: "active", position: 0 });
    } else {
      queue.set(sub.id, { state: "waiting", position: ++position });
    }
  }
  return queue;
}
