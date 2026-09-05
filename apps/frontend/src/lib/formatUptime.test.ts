import { expect, test } from "vitest";
import { formatUptime } from "./formatUptime.js";

test("renders a fresh start as zero seconds rather than an empty string", () => {
  expect(formatUptime(0)).toBe("0s");
});

test("renders sub-minute uptime as bare seconds", () => {
  expect(formatUptime(45_000)).toBe("45s");
});

test("pads seconds once minutes are shown so the width stops jittering", () => {
  expect(formatUptime(3 * 60_000 + 7_000)).toBe("3m 07s");
});

test("shows hours, padded minutes and padded seconds", () => {
  expect(formatUptime(2 * 3_600_000 + 14 * 60_000 + 3_000)).toBe("2h 14m 03s");
});

test("drops seconds past a day, where they are noise", () => {
  expect(formatUptime(26 * 3_600_000 + 12 * 60_000 + 5_000)).toBe("1d 02h 12m");
});

test("truncates sub-second remainders instead of rounding up to a second early", () => {
  expect(formatUptime(1_999)).toBe("1s");
});

test("treats a negative elapsed time as zero, so clock skew cannot render '-3s'", () => {
  expect(formatUptime(-3_000)).toBe("0s");
});
