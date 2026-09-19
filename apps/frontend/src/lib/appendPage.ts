/**
 * A page of live-streamed items, with `total` counting every item the
 * server has ever produced -- including ones since evicted from its
 * buffer. That count is what places a pushed frame against what is
 * already on screen, and what makes a gap detectable at all.
 */
export interface LivePage<T> {
  items: T[];
  total: number;
}

/**
 * Adds a pushed frame's new items to `current`.
 *
 * Items already there are skipped; null means items were missed between
 * the two, so only a reload can close the gap.
 *
 * Generic over the item because the miner log (strings) and the app event
 * log (objects) stream through the identical mechanism. This is the
 * subtlest logic in the app and a second, near-identical copy of it would
 * be where the two quietly drift apart.
 */
export function appendPage<T>(
  current: LivePage<T>,
  frame: LivePage<T>,
  maxItems: number,
): LivePage<T> | null {
  const fresh = frame.total - current.total;
  if (fresh <= 0) return current;
  if (fresh > frame.items.length) return null;
  return {
    items: [
      ...current.items,
      ...frame.items.slice(frame.items.length - fresh),
    ].slice(-maxItems),
    total: frame.total,
  };
}
