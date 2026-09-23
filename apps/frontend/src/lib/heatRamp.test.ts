import { expect, test } from "vitest";
import { HEAT_EMPTY, HEAT_STEPS, heatColor } from "./heatRamp.js";

test("never is the empty colour, not the faintest step", () => {
  expect(heatColor(0)).toBe(HEAT_EMPTY);
});

test("fractions fill four equal bands, faint to bright", () => {
  expect(heatColor(0.1)).toBe(HEAT_STEPS[0]);
  expect(heatColor(0.25)).toBe(HEAT_STEPS[0]);
  expect(heatColor(0.26)).toBe(HEAT_STEPS[1]);
  expect(heatColor(0.5)).toBe(HEAT_STEPS[1]);
  expect(heatColor(0.75)).toBe(HEAT_STEPS[2]);
  expect(heatColor(0.9)).toBe(HEAT_STEPS[3]);
  expect(heatColor(1)).toBe(HEAT_STEPS[3]);
});
