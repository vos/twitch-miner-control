import { expect, test } from "vitest";
import { AVERAGE_SAMPLES, HISTORY_CAPACITY, appendSample, averageOf } from "./rollingHistory.js";

const sample = (at: number, cpu: number | null = 1) => ({ at, cpu, rssBytes: 100 });

test("appends a new reading", () => {
  const next = appendSample([], sample(1000));
  expect(next).toHaveLength(1);
});

test("ignores a reading already held", () => {
  // The status poll re-renders the app on every response. Appending per
  // render rather than per new reading would fill the buffer with
  // duplicates and flatten the average onto one repeated value.
  const history = appendSample([], sample(1000));
  expect(appendSample(history, sample(1000))).toBe(history);
});

test("evicts the oldest reading past capacity", () => {
  let history: ReturnType<typeof appendSample> = [];
  for (let i = 0; i <= HISTORY_CAPACITY; i++) history = appendSample(history, sample(i * 1000));
  expect(history).toHaveLength(HISTORY_CAPACITY);
  expect(history[0]?.at).toBe(1000);
});

test("clears when the miner stops", () => {
  const history = appendSample([], sample(1000));
  // Splicing a new run onto the old one would draw a line across the
  // dead time between them as though it were continuous.
  expect(appendSample(history, null)).toEqual([]);
});

test("holds an empty history steady when nothing is running", () => {
  const history: ReturnType<typeof appendSample> = [];
  // Must be the same array, or a stopped miner re-renders the header
  // forever on a new empty array every poll.
  expect(appendSample(history, null)).toBe(history);
});

test("averages the readings it has", () => {
  let history: ReturnType<typeof appendSample> = [];
  history = appendSample(history, sample(1000, 10));
  history = appendSample(history, sample(2000, 20));
  expect(averageOf(history)).toBe(15);
});

test("averages only the most recent minute's readings", () => {
  let history: ReturnType<typeof appendSample> = [];
  // An old, hot reading outside the averaging window must not drag the
  // figure the header labels as a one-minute mean.
  history = appendSample(history, sample(0, 100));
  for (let i = 1; i <= AVERAGE_SAMPLES; i++) history = appendSample(history, sample(i * 1000, 10));
  expect(averageOf(history)).toBe(10);
});

test("skips readings with no cpu figure", () => {
  let history: ReturnType<typeof appendSample> = [];
  // The first sample after a start has no delta to report; averaging it
  // in as a zero would halve the figure shown beside it.
  history = appendSample(history, sample(1000, null));
  history = appendSample(history, sample(2000, 20));
  expect(averageOf(history)).toBe(20);
});

test("reports no average before any cpu figure exists", () => {
  expect(averageOf([])).toBeNull();
  expect(averageOf([sample(1000, null)])).toBeNull();
});
