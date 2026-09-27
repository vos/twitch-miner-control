import { formatDateHour } from "./formatClock.js";
import { formatSpan } from "./formatSpan.js";
import type { GiftSub } from "../api/useLiveState.js";

/** "Tier 1 gift sub", or the product name where the tier is not a number. */
export function giftTitle(g: GiftSub): string {
  return typeof g.tier === "number" ? `Tier ${g.tier} gift sub` : `${g.product} gift`;
}

/** Who gave it, or null for an anonymous gift. */
export function giftFrom(g: GiftSub): string | null {
  return g.gifter?.displayName ?? null;
}

/** "Ends Oct 6, 16:17 · in 9d" -- the date to plan by, and the span to scan by. */
export function giftEnds(g: GiftSub, now: number): string {
  if (g.endsAt <= now) return "Ended";
  return `Ends ${formatDateHour(g.endsAt)} · in ${formatSpan(g.endsAt - now)}`;
}
