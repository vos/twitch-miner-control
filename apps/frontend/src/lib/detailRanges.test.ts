import { expect, test } from "vitest";
import { rangeWindow, RANGE_KEYS, RANGE_LABELS } from "./detailRanges.js";

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

test("24h looks back one day", () => {
  expect(rangeWindow("24h", NOW)).toEqual({ from: NOW - 24 * HOUR, to: NOW });
});

test("7d looks back seven days", () => {
  expect(rangeWindow("7d", NOW)).toEqual({ from: NOW - 7 * 24 * HOUR, to: NOW });
});

test("30d looks back thirty days", () => {
  expect(rangeWindow("30d", NOW)).toEqual({ from: NOW - 30 * 24 * HOUR, to: NOW });
});

test("all starts at zero so the server answers with whatever it kept", () => {
  expect(rangeWindow("all", NOW)).toEqual({ from: 0, to: NOW });
});

test("every key has a label", () => {
  for (const key of RANGE_KEYS) expect(RANGE_LABELS[key]).toBeTruthy();
});
