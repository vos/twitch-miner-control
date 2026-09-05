import { expect, test } from "vitest";
import { downsample } from "./gains.js";

test("returns an empty array when there is nothing to draw", () => {
  expect(downsample([], 0, 1000, 4)).toEqual([]);
});

test("buckets by time, not by row, so a burst does not dominate the shape", () => {
  // Three rows in the first bucket, one in the last. Row-based sampling
  // would render the burst as most of the line; time bucketing must not.
  const samples = [
    { ts: 10, balance: 1 }, { ts: 20, balance: 2 }, { ts: 30, balance: 3 },
    { ts: 900, balance: 9 },
  ];
  expect(downsample(samples, 0, 1000, 4)).toEqual([3, 3, 3, 9]);
});

test("carries the last known balance through quiet buckets", () => {
  // Change-only writes mean a quiet hour has no row; it is flat, not absent.
  const samples = [{ ts: 10, balance: 5 }, { ts: 990, balance: 8 }];
  expect(downsample(samples, 0, 1000, 4)).toEqual([5, 5, 5, 8]);
});

test("back-fills leading buckets that precede the first sample", () => {
  // Nothing known before the first row: flat at the earliest balance
  // rather than a fake climb from zero.
  const samples = [{ ts: 800, balance: 42 }];
  expect(downsample(samples, 0, 1000, 4)).toEqual([42, 42, 42, 42]);
});

test("always returns exactly the requested bucket count", () => {
  const samples = [{ ts: 500, balance: 1 }];
  expect(downsample(samples, 0, 1000, 24)).toHaveLength(24);
});
