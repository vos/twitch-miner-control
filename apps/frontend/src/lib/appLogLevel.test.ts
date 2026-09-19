import { expect, test } from "vitest";
import { atLeast, classOf } from "./appLogLevel.js";

test("all shows everything", () => {
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
    expect(atLeast(level, "all")).toBe(true);
  }
});

test("a threshold is a minimum, not a selection", () => {
  // "Warnings and worse" is the question people ask of a log.
  expect(atLeast("error", "warn")).toBe(true);
  expect(atLeast("warn", "warn")).toBe(true);
  expect(atLeast("info", "warn")).toBe(false);
  expect(atLeast("debug", "warn")).toBe(false);
});

test("an unknown level always shows", () => {
  // A line from a future build must not vanish from the one view meant
  // to explain what happened.
  expect(atLeast("surprise", "error")).toBe(true);
});

test("fatal is coloured as an error", () => {
  expect(classOf("fatal")).toBe("error");
  expect(classOf("error")).toBe("error");
});

test("trace recedes like debug", () => {
  expect(classOf("trace")).toBe("debug");
  expect(classOf("debug")).toBe("debug");
});

test("anything else reads as info", () => {
  expect(classOf("info")).toBe("info");
  expect(classOf("surprise")).toBe("info");
});
