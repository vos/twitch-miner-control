import { expect, test } from "vitest";
import { roundViewers } from "./viewers.js";

test("leaves a small count exact", () => {
  // A channel with 47 viewers is a channel with 47 viewers -- rounding
  // here would be visible, since the card prints the figure as-is.
  expect(roundViewers(47)).toBe(47);
  expect(roundViewers(892)).toBe(892);
});

test("rounds a four-figure count to three significant figures", () => {
  expect(roundViewers(1247)).toBe(1250);
  expect(roundViewers(1204)).toBe(1200);
});

test("rounds larger counts proportionally", () => {
  expect(roundViewers(18_432)).toBe(18_400);
  expect(roundViewers(247_881)).toBe(248_000);
});

test("keeps a rounded count stable across small drifts", () => {
  // The whole point: a channel drifting by a few viewers must produce
  // the same number twice, or every poll wakes every SSE client.
  expect(roundViewers(18_432)).toBe(roundViewers(18_449));
});

test("passes zero and null through untouched", () => {
  expect(roundViewers(0)).toBe(0);
  expect(roundViewers(null)).toBeNull();
});

test("never rounds a live channel down to zero", () => {
  // "0 viewers" on a card that says LIVE is a contradiction the rounding
  // must not be able to manufacture.
  expect(roundViewers(1)).toBe(1);
  expect(roundViewers(4)).toBe(4);
});
