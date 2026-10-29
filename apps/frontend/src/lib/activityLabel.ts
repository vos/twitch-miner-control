/**
 * Turns GAIN_FOR_CLAIM into "claim".
 *
 * The card wants a short label; the events feed already renders the
 * miner's full line, so repeating it here would just truncate badly. The
 * label always comes from the event *type*, which the doorbell route
 * validates against a bounded pattern, never from the message.
 */
export function activityLabel(type: string): string {
  return type.toLowerCase().replace(/^gain_for_/, "").replace(/_/g, " ");
}
