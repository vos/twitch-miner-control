import { expect, test } from "vitest";
import { formatViewers } from "./formatViewers.js";

test("prints a small audience exactly", () => {
  expect(formatViewers(47)).toBe("47");
  expect(formatViewers(892)).toBe("892");
});

test("abbreviates a four-figure audience to one decimal", () => {
  expect(formatViewers(1200)).toBe("1.2K");
  expect(formatViewers(18_400)).toBe("18.4K");
});

test("drops the decimal once it stops carrying information", () => {
  // "248.0K" spends a character on a zero that the rounding upstream
  // guarantees; at six figures the tenth of a thousand is noise anyway.
  expect(formatViewers(248_000)).toBe("248K");
  expect(formatViewers(1000)).toBe("1K");
});

test("abbreviates a seven-figure audience with M", () => {
  expect(formatViewers(1_200_000)).toBe("1.2M");
});

test("reports nothing for an offline channel", () => {
  expect(formatViewers(null)).toBeNull();
});
