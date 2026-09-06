import { expect, test } from "vitest";
import { formatSpan } from "./formatSpan.js";

test("labels whole hours", () => {
  expect(formatSpan(3 * 3_600_000)).toBe("3h");
});

test("labels sub-hour spans in minutes", () => {
  expect(formatSpan(12 * 60_000)).toBe("12m");
});

test("rounds to the nearest unit rather than truncating", () => {
  // 59 minutes is "about an hour", not "59m"; 3.9h is "4h", not "3h".
  expect(formatSpan(59 * 60_000)).toBe("1h");
  expect(formatSpan(3.9 * 3_600_000)).toBe("4h");
});

test("never renders a zero span, which would read as no time at all", () => {
  expect(formatSpan(20_000)).toBe("1m");
  expect(formatSpan(0)).toBe("1m");
});

test("rolls over to days past 48h", () => {
  // The all-time mining figure reaches hundreds of hours, and "1400h" is
  // a number to decode rather than read.
  expect(formatSpan(72 * 3_600_000)).toBe("3d");
  expect(formatSpan(142 * 3_600_000)).toBe("6d");
});

test("keeps hours up to 48h", () => {
  // Guards every existing caller: the gain windows and the 24h figures
  // never reach the new branch, so their labels are untouched.
  expect(formatSpan(47 * 3_600_000)).toBe("47h");
});
