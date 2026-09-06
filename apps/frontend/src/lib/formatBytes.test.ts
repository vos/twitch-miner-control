import { expect, test } from "vitest";
import { formatBytes } from "./formatBytes.js";

test("renders megabytes without a fractional part", () => {
  // A miner's RSS moves by megabytes; a decimal place here would be
  // noise that changes on every poll.
  expect(formatBytes(148 * 1024 * 1024)).toBe("148 MB");
});

test("switches to gigabytes past a thousand megabytes", () => {
  expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
});

test("keeps one decimal in gigabytes so the width does not jump", () => {
  // "2 GB" and "2.5 GB" alternating would shift the badge beside it.
  expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
});

test("floors below a megabyte rather than rendering bytes", () => {
  // The header has no room for a unit that only appears in the first
  // moments of a process's life.
  expect(formatBytes(1000)).toBe("0 MB");
});

test("clamps a negative value", () => {
  expect(formatBytes(-1)).toBe("0 MB");
});
