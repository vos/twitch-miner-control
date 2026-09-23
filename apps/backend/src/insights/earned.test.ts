import { expect, test } from "vitest";
import { earnedFor } from "./earned.js";

test("earned is the sum of the rises", () => {
  expect(earnedFor(null, [100, 150, 200])).toBe(100);
});

test("a fall is spending, not negative earning", () => {
  expect(earnedFor(null, [100, 150, 50, 80])).toBe(80);
});

test("the first balance counts against the one before the window", () => {
  expect(earnedFor(90, [100, 150])).toBe(60);
});

test("with nothing before it, the first balance is only a starting point", () => {
  expect(earnedFor(null, [100])).toBe(0);
});

test("no balances, no earnings", () => {
  expect(earnedFor(100, [])).toBe(0);
});
