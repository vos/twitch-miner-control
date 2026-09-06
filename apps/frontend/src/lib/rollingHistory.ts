import { useRef } from "react";

export interface ProcSample {
  /** Percent of one core, or null when no delta could be formed yet. */
  cpu: number | null;
  rssBytes: number;
  /** When the reading was taken, used to tell a new sample from a repeat. */
  at: number;
}

/** The status poll's interval, which sets what a sample count is worth in seconds. */
export const POLL_MS = 5000;

/**
 * How many samples the graph plots: 2 minutes at the poll's cadence.
 * Wide enough to show a trend, narrow enough that the sparkline does not
 * compress into a smear at the header's width.
 */
export const HISTORY_CAPACITY = 24;

/** One minute's worth of samples -- the window the readout is labelled by. */
export const AVERAGE_SAMPLES = 12;

/**
 * Appends a status poll's reading to the rolling history.
 *
 * Returns the SAME array when nothing changed, so React can skip a
 * re-render: the status poll re-renders the app every 5 seconds whether
 * or not the miner is running, and a stopped miner must not produce a
 * fresh empty array on each one.
 *
 * A null sample (miner stopped, or /proc unreadable) empties the buffer
 * rather than leaving it to drain. A restarted miner is a different
 * process, and joining its readings onto the previous run's would draw
 * one continuous line straight across the dead time between them --
 * exactly the shape an operator would read as "it never went down".
 */
export function appendSample(
  history: readonly ProcSample[],
  sample: ProcSample | null,
): readonly ProcSample[] {
  if (sample === null) return history.length === 0 ? history : [];
  // Same reading as last poll: the app re-rendered without new data.
  if (history[history.length - 1]?.at === sample.at) return history;
  return [...history, sample].slice(-HISTORY_CAPACITY);
}

/**
 * Mean CPU across the last minute's samples, or null if none carry a
 * figure yet.
 *
 * Averages the last AVERAGE_SAMPLES readings rather than the whole
 * buffer, so the number matches the window the header labels it with
 * while the graph still plots the wider history. Samples whose cpu is
 * null (the first reading of a process, which has no delta) are skipped
 * rather than counted as zero, which would drag the mean down.
 */
export function averageOf(history: readonly ProcSample[]): number | null {
  const values = history
    .slice(-AVERAGE_SAMPLES)
    .map((s) => s.cpu)
    .filter((cpu): cpu is number => cpu !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Keeps the rolling history across renders.
 *
 * A ref rather than state: every sample this could store arrives with a
 * status poll that is already re-rendering the app, so setting state
 * here would only schedule a second render for data the first one can
 * already see.
 */
export function useRollingHistory(sample: ProcSample | null): readonly ProcSample[] {
  const history = useRef<readonly ProcSample[]>([]);
  history.current = appendSample(history.current, sample);
  return history.current;
}
