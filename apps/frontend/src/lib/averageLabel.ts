import { AVERAGE_SAMPLES, POLL_MS } from "./rollingHistory.js";

/**
 * Names the window a CPU average actually covers.
 *
 * For the first minute after a miner starts there are fewer than
 * AVERAGE_SAMPLES readings, so the mean is real but narrower than the
 * minute the header eventually settles on. Rather than hiding the
 * number until the window fills -- leaving the readout blank for the
 * first minute of every run, when an operator is most likely watching --
 * or labelling a 15-second mean as a minute's, the label states the
 * window it has: "15s avg" widening to "1m avg" and staying there.
 *
 * This keeps the figure's meaning fixed. Falling back to the raw current
 * value and swapping to an average later would change what the number
 * means partway through, with nothing on screen marking the switch.
 */
export function averageLabel(sampleCount: number): string {
  const counted = Math.min(sampleCount, AVERAGE_SAMPLES);
  if (counted >= AVERAGE_SAMPLES) return "1m avg";
  return `${Math.round((counted * POLL_MS) / 1000)}s avg`;
}
