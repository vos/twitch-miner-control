import { parseActivity } from "./parseActivity.js";

export interface ActivityInput {
  ts: number;
  type: string;
  message: string | null;
}

export interface ActivityRow {
  /** The newest event in the run: what the row is dated by. */
  ts: number;
  type: string;
  /** Short label, from the event type. */
  label: string;
  /** How many consecutive events this row stands for. 1 is not a run. */
  count: number;
  /**
   * Points the whole run earned, or null when none of it carried any.
   *
   * Summed, never sampled: three ten-point watch gains are thirty points,
   * and a row reporting only the first would make the feed disagree with
   * the balance above it. Null rather than 0 for a run of status events --
   * "+0" claims the miner earned nothing from something that was never
   * about points.
   */
  earned: number | null;
}

/**
 * Folds consecutive runs of the same event type into single rows.
 *
 * A channel flapping between online and offline writes one event per
 * poll, so a quiet night arrives as fifteen identical "streamer offline"
 * lines that push everything informative off the screen. The run is one
 * fact -- "this kept happening" -- and reads better as one row that says
 * how many times.
 *
 * Runs are *consecutive only*. Two separated stretches of offline events
 * stay two rows: the gap between them is a different state the channel
 * passed through, and merging across it would claim a continuity the
 * events deny.
 *
 * The caller groups by day first and collapses each day's list, so a run
 * never spans a date heading -- a row under "Thu" must not silently
 * describe Wednesday.
 *
 * The grouping key is the event *type*, not the rendered label or the
 * amount: the label is derived from the type, and two claims of
 * different sizes are still two claims. Their amounts sum.
 */
export function collapseActivity(events: ActivityInput[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const event of events) {
    const { earned, label } = parseActivity(event.type, event.message);
    const open = rows[rows.length - 1];
    if (open !== undefined && open.type === event.type) {
      open.count += 1;
      // Null stays null until something in the run actually earned.
      if (earned !== null) open.earned = (open.earned ?? 0) + earned;
      continue;
    }
    rows.push({ ts: event.ts, type: event.type, label, count: 1, earned });
  }
  return rows;
}
