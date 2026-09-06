import type { StreamerState } from "../api/useLiveState.js";

/** The orderings the dashboard offers, in the order the control lists them. */
export const SORT_KEYS = ["default", "name", "gain", "recent"] as const;

export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_LABELS: Record<SortKey, string> = {
  default: "Default",
  name: "Name",
  gain: "24h gain",
  recent: "Recently live",
};

/**
 * Which half of the dashboard is being sorted.
 *
 * Only "recent" cares, and it cares because the field that answers "how
 * recently" differs by state: a live channel has no `lastLive` (it has not
 * gone off yet) and an offline one has no `liveSince`. Sorting both halves
 * on one field would leave one of them in arbitrary order.
 */
export type Section = "live" | "offline";

/**
 * Sorts missing data to the bottom whichever direction the sort runs.
 *
 * `null` here means "we have no answer" -- no baseline yet, never seen
 * live -- which is not the same claim as zero or as long-ago, and must not
 * be ranked as either.
 */
function compareNullable(a: number | null, b: number | null, descending: boolean): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return descending ? b - a : a - b;
}

function comparator(key: SortKey, section: Section):
  ((a: StreamerState, b: StreamerState) => number) | null {
  switch (key) {
    case "name":
      // The card renders displayName, so ordering by the login would sort
      // the grid by a string the user cannot see.
      return (a, b) => (a.displayName ?? a.username)
        .localeCompare(b.displayName ?? b.username, undefined, { sensitivity: "base" });
    case "gain":
      return (a, b) => compareNullable(a.gained24h, b.gained24h, true);
    case "recent":
      // Live: the oldest start is the longest-running stream, so ascending.
      // Offline: the newest `lastLive` is the freshest, so descending.
      return section === "live"
        ? (a, b) => compareNullable(a.liveSince, b.liveSince, false)
        : (a, b) => compareNullable(a.lastLive, b.lastLive, true);
    default:
      // "default" and anything unrecognised -- a stale or hand-edited
      // preference must degrade to the roster, never to a scrambled grid.
      return null;
  }
}

/**
 * Orders one section of the dashboard, leaving the input untouched.
 *
 * Ties fall back to roster order: `Array.prototype.sort` is stable per
 * spec, so equal cards keep the position they arrived in. That matters
 * more here than it looks -- the grid re-renders on every SSE frame, and
 * an unstable tie would shuffle cards under the pointer once a second.
 */
export function sortStreamers(
  streamers: StreamerState[],
  key: SortKey,
  section: Section,
): StreamerState[] {
  const compare = comparator(key, section);
  if (compare === null) return streamers;
  return [...streamers].sort(compare);
}
