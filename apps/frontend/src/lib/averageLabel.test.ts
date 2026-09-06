import { expect, test } from "vitest";
import { AVERAGE_SAMPLES } from "./rollingHistory.js";
import { averageLabel } from "./averageLabel.js";

test("names the true window while it is still filling", () => {
  // Claiming "1m avg" over three samples would overstate what the
  // number is; the window it actually covers is 15 seconds.
  expect(averageLabel(3)).toBe("15s avg");
});

test("settles on a minute once the window is full", () => {
  expect(averageLabel(AVERAGE_SAMPLES)).toBe("1m avg");
});

test("stays at a minute once the buffer runs past the window", () => {
  // The buffer holds two minutes for the graph, but the average is
  // always taken over the last minute of it.
  expect(averageLabel(AVERAGE_SAMPLES * 2)).toBe("1m avg");
});

test("rounds a part-filled window to whole seconds", () => {
  expect(averageLabel(1)).toBe("5s avg");
  expect(averageLabel(11)).toBe("55s avg");
});
