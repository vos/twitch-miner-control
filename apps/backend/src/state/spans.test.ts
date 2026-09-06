import { expect, test } from "vitest";
import { clip, intersect, total } from "./spans.js";

test("clips a span to the window", () => {
  expect(clip([{ start: 0, end: 100 }], 25, 75)).toEqual([{ start: 25, end: 75 }]);
});

test("drops spans entirely outside the window", () => {
  expect(clip([{ start: 0, end: 10 }], 50, 100)).toEqual([]);
});

test("keeps a span that covers the whole window", () => {
  expect(clip([{ start: 0, end: 1000 }], 100, 200)).toEqual([{ start: 100, end: 200 }]);
});

test("treats an open span as ending at the window end", () => {
  // `end: null` means "still running". The window's end is the caller's
  // "now", so an open span is resolved against it rather than Infinity.
  expect(clip([{ start: 50, end: null }], 0, 100)).toEqual([{ start: 50, end: 100 }]);
});

test("drops zero-length spans", () => {
  // A stream closed at its own start (no evidence we ever watched it)
  // contributes nothing, and letting it through would mean every caller
  // has to filter it again.
  expect(clip([{ start: 50, end: 50 }], 0, 100)).toEqual([]);
});

test("intersects overlapping spans", () => {
  expect(intersect(
    [{ start: 0, end: 100 }],
    [{ start: 50, end: 150 }],
  )).toEqual([{ start: 50, end: 100 }]);
});

test("intersects one span against many", () => {
  expect(intersect(
    [{ start: 0, end: 100 }],
    [{ start: 10, end: 20 }, { start: 30, end: 40 }],
  )).toEqual([{ start: 10, end: 20 }, { start: 30, end: 40 }]);
});

test("returns nothing when spans do not overlap", () => {
  expect(intersect([{ start: 0, end: 10 }], [{ start: 20, end: 30 }])).toEqual([]);
});

test("returns nothing when either side is empty", () => {
  // The miner never ran, so no online time can count as mined.
  expect(intersect([{ start: 0, end: 10 }], [])).toEqual([]);
  expect(intersect([], [{ start: 0, end: 10 }])).toEqual([]);
});

test("treats adjacent spans as non-overlapping", () => {
  // Touching at a single instant is not overlap: the miner started the
  // moment the stream ended, which is zero mining time.
  expect(intersect([{ start: 0, end: 50 }], [{ start: 50, end: 100 }])).toEqual([]);
});

test("keeps an overlap of two open spans open", () => {
  // Both still running: the overlap is still running too, so it must not
  // be resolved to a number here -- only the caller knows "now".
  expect(intersect(
    [{ start: 0, end: null }],
    [{ start: 50, end: null }],
  )).toEqual([{ start: 50, end: Infinity }]);
});

test("sums spans", () => {
  expect(total([{ start: 0, end: 50 }, { start: 100, end: 125 }])).toBe(75);
});

test("sums nothing to zero", () => {
  expect(total([])).toBe(0);
});

test("clipping an intersection resolves open overlaps", () => {
  // The real pipeline: intersect can emit Infinity, and clip is always
  // applied before total, so no infinity ever reaches a displayed figure.
  const online = clip([{ start: 1000, end: null }], 0, 10_000);
  const miner = clip([{ start: 2000, end: null }], 0, 10_000);
  expect(total(intersect(online, miner))).toBe(8000);
});
