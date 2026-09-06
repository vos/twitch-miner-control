import { expect, test } from "vitest";
import { formatLiveSpan } from "./useLiveDuration.js";

const M = 60_000, H = 60 * M, D = 24 * H;

test("shows bare minutes under an hour", () => {
  expect(formatLiveSpan(5 * M)).toBe("5m");
  expect(formatLiveSpan(59 * M)).toBe("59m");
});

test("pads minutes once an hour leads", () => {
  // Unpadded, "3h 7m" -> "3h 12m" changes width on the tick and shifts
  // the badge beside it.
  expect(formatLiveSpan(3 * H + 7 * M)).toBe("3h 07m");
  expect(formatLiveSpan(13 * H + 9 * M)).toBe("13h 09m");
});

test("drops to days and hours past a day", () => {
  expect(formatLiveSpan(D + 3 * H + 38 * M)).toBe("1d 03h");
});

test("truncates rather than rounding", () => {
  // A stream 59 minutes in has not been live "1h".
  expect(formatLiveSpan(59 * M + 59_000)).toBe("59m");
});

test("carries no seconds", () => {
  // Seconds would repaint the loudest element on the card once a second.
  expect(formatLiveSpan(45_000)).toBe("0m");
  expect(formatLiveSpan(2 * H + 30 * M + 45_000)).toBe("2h 30m");
});

test("clamps a negative span to zero", () => {
  // Clock skew between the server's timestamp and the browser.
  expect(formatLiveSpan(-5000)).toBe("0m");
});
