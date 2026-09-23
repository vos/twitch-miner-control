import { expect, test } from "vitest";
import { HEAT_EMPTY, HEAT_STEPS } from "./heatRamp.js";
import {
  changeLabel, describeDay, formatHoursMinutes, periodLabel, quantileSteps,
  recapFilename, stepColor, weekOffsetOf,
} from "./insightsFormat.js";

const at = (month: number, day: number, hour = 0) =>
  new Date(2026, month - 1, day, hour).getTime();

test("thresholds are quartiles of the non-zero days", () => {
  expect(quantileSteps([0, 0, 10, 20, 30, 40, 50])).toEqual([20, 30, 40]);
  expect(quantileSteps([0, 0])).toEqual([]);
});

test("a day's colour follows the thresholds; zero is empty", () => {
  const t = [20, 30, 40];
  expect(stepColor(0, t)).toBe(HEAT_EMPTY);
  expect(stepColor(10, t)).toBe(HEAT_STEPS[0]);
  expect(stepColor(20, t)).toBe(HEAT_STEPS[0]);
  expect(stepColor(25, t)).toBe(HEAT_STEPS[1]);
  expect(stepColor(40, t)).toBe(HEAT_STEPS[2]);
  expect(stepColor(99, t)).toBe(HEAT_STEPS[3]);
  // One non-zero day: no thresholds, and it is simply the brightest.
  expect(stepColor(5, [])).toBe(HEAT_STEPS[3]);
});

test("a day maps to the offset of the week that contains it", () => {
  const now = at(9, 17, 12); // Thursday
  expect(weekOffsetOf("2026-09-14", now)).toBe(0);
  expect(weekOffsetOf("2026-09-20", now)).toBe(0);
  expect(weekOffsetOf("2026-09-13", now)).toBe(-1);
  expect(weekOffsetOf("2026-08-31", now)).toBe(-2);
});

test("hours and minutes read as a duration", () => {
  expect(formatHoursMinutes(0)).toBe("0m");
  expect(formatHoursMinutes(45 * 60_000)).toBe("45m");
  expect(formatHoursMinutes(6 * 3_600_000 + 12 * 60_000)).toBe("6h 12m");
  expect(formatHoursMinutes(31 * 3_600_000)).toBe("31h");
});

test("a day's tooltip says what it holds", () => {
  const day = {
    date: "2026-09-15", earned: 8420, minedMs: 6 * 3_600_000 + 12 * 60_000,
    top: { login: "alphatv", displayName: "AlphaTV", earned: 5000 },
  };
  expect(describeDay(day, "2026-09-01")).toBe("Tue 15 Sep · 8,420 earned · 6h 12m mined · top: AlphaTV");
  expect(describeDay({ ...day, earned: 0, minedMs: 0, top: null }, "2026-09-01"))
    .toBe("Tue 15 Sep · nothing earned");
  expect(describeDay(day, "2026-09-16")).toBe("Tue 15 Sep · before tracking began");
});

test("a period is labelled as the card shows it", () => {
  expect(periodLabel({ kind: "week", from: at(9, 14), to: at(9, 17), partial: true }))
    .toBe("WEEK OF SEP 14–20 · 2026 · SO FAR");
  expect(periodLabel({ kind: "week", from: at(9, 28), to: at(10, 5), partial: false }))
    .toBe("WEEK OF SEP 28–OCT 4 · 2026");
  expect(periodLabel({ kind: "month", from: at(8, 1), to: at(9, 1), partial: false }))
    .toBe("AUGUST 2026");
});

test("changes read as arrows against the period before", () => {
  expect(changeLabel("earned", 112, 100)).toBe("▲ 12%");
  expect(changeLabel("earned", 90, 100)).toBe("▼ 10%");
  expect(changeLabel("earned", 50, 0)).toBeNull();
  expect(changeLabel("mined", 5 * 3_600_000, 2 * 3_600_000)).toBe("▲ 3h");
  expect(changeLabel("uptime", 92, 94)).toBe("▼ 2 pts");
  expect(changeLabel("uptime", 94, 94)).toBe("no change");
});

test("the export is named for its period", () => {
  expect(recapFilename({ kind: "week", from: at(9, 14), to: at(9, 17), partial: true }))
    .toBe("twitch-miner-week-2026-09-14.png");
  expect(recapFilename({ kind: "month", from: at(9, 1), to: at(9, 17), partial: true }))
    .toBe("twitch-miner-month-2026-09.png");
});
