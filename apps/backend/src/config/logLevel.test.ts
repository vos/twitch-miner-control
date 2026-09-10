import { expect, test } from "vitest";
import { MINER_LOG_LEVEL, resolveMinerLogLevel } from "./logLevel.js";

test("defaults when unset", () => {
  expect(resolveMinerLogLevel(undefined)).toBe(MINER_LOG_LEVEL);
  // A bare `MINER_LOG_LEVEL=` is an unset variable, not a level.
  expect(resolveMinerLogLevel("")).toBe(MINER_LOG_LEVEL);
  expect(resolveMinerLogLevel("   ")).toBe(MINER_LOG_LEVEL);
});

test("defaults to INFO, not upstream's DEBUG", () => {
  // The whole point of the knob: upstream's LoggerSettings defaults
  // file_level to DEBUG, which wrote ~267MB in a single day.
  expect(MINER_LOG_LEVEL).toBe("INFO");
});

test("accepts every level the miner's file handler understands", () => {
  for (const level of ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]) {
    expect(resolveMinerLogLevel(level)).toBe(level);
  }
});

test("normalises case and surrounding whitespace", () => {
  expect(resolveMinerLogLevel("debug")).toBe("DEBUG");
  expect(resolveMinerLogLevel("  Warning  ")).toBe("WARNING");
});

test("accepts WARN as an alias for WARNING", () => {
  // Python's getLevelName() does not accept WARN, but most other logging
  // ecosystems call it that, so it is worth honouring rather than
  // silently falling back to INFO.
  expect(resolveMinerLogLevel("WARN")).toBe("WARNING");
  expect(resolveMinerLogLevel("warn")).toBe("WARNING");
});

test("falls back on an unrecognised level", () => {
  // Must not throw: the miner is spawned by the supervisor, so a throw
  // would surface as a crash-looping miner rather than as a bad .env.
  expect(resolveMinerLogLevel("VERBOSE")).toBe(MINER_LOG_LEVEL);
  expect(resolveMinerLogLevel("10")).toBe(MINER_LOG_LEVEL);
  expect(resolveMinerLogLevel("NOTSET")).toBe(MINER_LOG_LEVEL);
});
