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

test("keeps the tenth below six figures, even when it is a zero", () => {
  // "2K" throws away precision the snapshot actually carries: 2,000 is
  // exact at this magnitude, and Twitch itself shows "2.0K". Only above
  // 100K, where the rounding has already dropped the tenth, is there no
  // tenth left to show.
  expect(formatViewers(2000)).toBe("2.0K");
  expect(formatViewers(1000)).toBe("1.0K");
  expect(formatViewers(248_000)).toBe("248K");
});

test("abbreviates a seven-figure audience with M", () => {
  expect(formatViewers(1_200_000)).toBe("1.2M");
});

test("reports nothing for an offline channel", () => {
  expect(formatViewers(null)).toBeNull();
});
