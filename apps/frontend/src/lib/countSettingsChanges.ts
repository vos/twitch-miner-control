/**
 * How many individual settings differ between the saved config and the draft.
 *
 * Order-insensitive by construction: the settings forms rebuild objects with
 * `withKey`, which deletes and re-appends a key rather than assigning in
 * place, so an edited-then-reverted field serialises with its keys in a new
 * order. A whole-object `JSON.stringify` comparison reads that as a change
 * and leaves a pending-change notice on screen that nothing can clear.
 *
 * Counting walks to the leaves so the notice can say how many settings are
 * actually staged -- a nested object counts as its changed fields, not as one.
 */
export function countChanges(before: unknown, after: unknown): number {
  if (Object.is(before, after)) return 0;

  // Arrays are ordered values (miner `priority` is a ranking), so any
  // difference is one change rather than a per-element tally.
  if (Array.isArray(before) || Array.isArray(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? 0 : 1;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    let count = 0;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      count += countChanges(before[key], after[key]);
    }
    return count;
  }

  // A leaf, or an object replaced by a scalar (weeklyRewards: {} -> false).
  return before === after ? 0 : 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
