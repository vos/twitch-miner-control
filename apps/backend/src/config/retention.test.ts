import { expect, test } from "vitest";
import { resolveRetentionDays, RETENTION_DAYS } from "./retention.js";

test("defaults when unset", () => {
  expect(resolveRetentionDays(undefined)).toBe(RETENTION_DAYS);
  // A bare `HISTORY_RETENTION_DAYS=` is an unset variable, not "0".
  expect(resolveRetentionDays("")).toBe(RETENTION_DAYS);
  expect(resolveRetentionDays("   ")).toBe(RETENTION_DAYS);
});

test("honours zero as never-prune", () => {
  // Must not be a falsy check: 0 is a real setting, not an absent one.
  expect(resolveRetentionDays("0")).toBe(0);
});

test("clamps below one day", () => {
  // Retention shorter than the 24h gain window would erode the gain
  // labels and the sparkline, which read the same table.
  expect(resolveRetentionDays("0.5")).toBe(1);
});

test("floors a fractional value", () => {
  expect(resolveRetentionDays("7.9")).toBe(7);
});

test("falls back on nonsense", () => {
  expect(resolveRetentionDays("soon")).toBe(RETENTION_DAYS);
  expect(resolveRetentionDays("-5")).toBe(RETENTION_DAYS);
  expect(resolveRetentionDays("NaN")).toBe(RETENTION_DAYS);
});
