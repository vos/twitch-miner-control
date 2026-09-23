import { expect, test } from "vitest";
import { addDays, dayKey, dayStart, monthStart, msByDay, weekStart } from "./days.js";

const at = (month: number, day: number, hour = 0, minute = 0) =>
  new Date(2026, month - 1, day, hour, minute).getTime();

test("a day key is the local calendar day", () => {
  expect(dayKey(at(9, 14, 0, 0))).toBe("2026-09-14");
  expect(dayKey(at(9, 14, 23, 59))).toBe("2026-09-14");
});

test("a day key starts at local midnight", () => {
  expect(dayStart("2026-09-14")).toBe(at(9, 14));
});

test("adding days crosses months and years", () => {
  expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
});

test("a week starts on the Monday that contains now", () => {
  expect(weekStart(at(9, 17, 12), 0)).toBe(at(9, 14)); // Thursday -> Monday
  expect(weekStart(at(9, 14, 0), 0)).toBe(at(9, 14)); // Monday itself
  expect(weekStart(at(9, 20, 23), 0)).toBe(at(9, 14)); // Sunday -> same week
  expect(weekStart(at(9, 17, 12), -1)).toBe(at(9, 7));
});

test("a month starts on its first day", () => {
  expect(monthStart(at(9, 17, 12), 0)).toBe(at(9, 1));
  expect(monthStart(at(9, 17, 12), -1)).toBe(at(8, 1));
  expect(monthStart(at(1, 17, 12), -1)).toBe(new Date(2025, 11, 1).getTime());
});

test("a span is split at local midnight", () => {
  const byDay = msByDay([{ start: at(9, 14, 22), end: at(9, 15, 1, 30) }]);
  expect(byDay.get("2026-09-14")).toBe(2 * 3_600_000);
  expect(byDay.get("2026-09-15")).toBe(1.5 * 3_600_000);
});

test("spans on the same day add up", () => {
  const byDay = msByDay([
    { start: at(9, 14, 1), end: at(9, 14, 2) },
    { start: at(9, 14, 5), end: at(9, 14, 5, 30) },
  ]);
  expect(byDay.get("2026-09-14")).toBe(1.5 * 3_600_000);
});
