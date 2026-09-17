import type { History, PointSample } from "../db/history.js";

/** The subset of History a gain window reads. */
type GainSource = Pick<History, "earliestSample" | "balanceAt">;

/**
 * The baseline a gain is measured from, plus the moment it describes.
 *
 * Prefers the balance in force at `from` -- a full window. When the
 * streamer has been tracked for less than that, falls back to its
 * earliest snapshot: a partial window is a real number over a real span,
 * and withholding it left a new streamer showing nothing for a day
 * despite the history to compute it sitting in the table.
 *
 * Returns null only when the sole snapshot is at or after `now`. There is
 * no *elapsed* time then, so any figure would be a confident "+0" about a
 * window that has not happened yet -- the one case the em dash is
 * actually telling the truth about.
 *
 * `ts` is null for a full window, and the real start for a short one, so
 * a caller can label three hours as "3h" rather than "24h". Never the
 * cutoff itself: that would encode "now" into a derived field, so every
 * tick would differ from the last and wake every SSE client with a
 * payload nothing actually changed in.
 *
 * Shared by the dashboard's gained24h and the detail dialog's per-range
 * gain. One implementation deliberately: the two figures sit on screen
 * together when the dialog is open over the card, and a second copy of
 * this rule would let them disagree about the same channel.
 */
export function gainWindow(
  history: GainSource,
  username: string,
  from: number,
  now: number,
): { ts: number | null; balance: number } | null {
  const earliest = history.earliestSample(username);
  if (earliest === null || earliest.ts >= now) return null;
  if (earliest.ts <= from) {
    const past = history.balanceAt(username, from);
    if (past !== null) return { ts: null, balance: past };
  }
  return earliest;
}

/**
 * Reduces a change-only series to a fixed-length array of balances for a
 * sparkline.
 *
 * Buckets by *time*, not by row index. Snapshots are written only when the
 * balance changes, so rows are unevenly spaced: a claim burst can put five
 * rows in one minute while a quiet hour has none. Taking every Nth row
 * would stretch the burst across most of the line and collapse the quiet
 * hour to nothing -- the shape would misreport when the earning happened.
 *
 * Each bucket holds the last balance known at its end, so quiet buckets
 * render flat (the balance genuinely did not move) rather than as gaps.
 * Buckets before the first sample are back-filled with the earliest known
 * balance: we do not know the value then, and starting from zero would
 * draw a dramatic climb that never happened.
 */
export function downsample(
  samples: PointSample[],
  fromTs: number,
  toTs: number,
  buckets = 24,
): number[] {
  if (samples.length === 0) return [];

  const span = toTs - fromTs;
  const width = span / buckets;
  const out: number[] = [];
  let cursor = 0;
  let carried: number | null = null;

  for (let i = 0; i < buckets; i++) {
    const end = fromTs + width * (i + 1);
    while (cursor < samples.length && samples[cursor].ts <= end) {
      carried = samples[cursor].balance;
      cursor++;
    }
    out.push(carried ?? samples[0].balance);
  }
  return out;
}
