import { expect, test } from "vitest";
import { formatClock, formatDateHour, formatDay } from "./formatClock.js";

// Local time throughout: the container runs Europe/Berlin and vitest
// pins no TZ, so fixtures are built the way the app reads them.
const at = (h: number, m = 0) => new Date(2026, 8, 17, h, m).getTime();

test("renders afternoon hours past twelve rather than with a meridiem", () => {
  const out = formatClock(at(15, 5));
  expect(out).toContain("15");
  expect(out).not.toMatch(/[AP]M/i);
});

test("pads the leading hour so a column of times stays one width", () => {
  expect(formatClock(at(9, 5))).toBe("09:05");
});

test("calls midnight 00, not 12 and not 24", () => {
  // hour12:false yields the h24 dial in some locales, which prints
  // "24:00" here -- the reason this pins hourCycle instead.
  expect(formatClock(at(0, 0))).toBe("00:00");
});

test("keeps the date stamp on the same 24-hour dial", () => {
  const out = formatDateHour(at(23));
  expect(out).toContain("23");
  expect(out).not.toMatch(/[AP]M/i);
});

test("keeps minutes on the date stamp so the hour reads as a time", () => {
  // "Sep 17, 15" reads as a quantity; the 12-hour dial it replaced got
  // away with a bare hour because "3 PM" carried its own unit.
  expect(formatDateHour(at(15))).toContain("15:00");
});

test("leaves the time off a day-only label", () => {
  expect(formatDay(at(15))).not.toContain("15:00");
});
