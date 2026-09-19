import { expect, test } from "vitest";
import {
  APP_LOG_LEVEL,
  APP_LOG_MAX_BYTES,
  APP_LOG_MIN_BYTES,
  resolveAppLogLevel,
  resolveAppLogMaxBytes,
} from "./appLogLevel.js";

test("the level defaults when unset", () => {
  expect(resolveAppLogLevel(undefined)).toBe(APP_LOG_LEVEL);
  expect(resolveAppLogLevel("")).toBe(APP_LOG_LEVEL);
  expect(resolveAppLogLevel("   ")).toBe(APP_LOG_LEVEL);
});

test("the default level is info", () => {
  // Decisions and their reasons, without the per-pass debug chatter.
  expect(APP_LOG_LEVEL).toBe("info");
});

test.each(["trace", "debug", "info", "warn", "error", "fatal", "silent"])(
  "%s is accepted",
  (level) => {
    expect(resolveAppLogLevel(level)).toBe(level);
  },
);

test.each(["off", "none", "disabled", "no", "false"])(
  "%s turns logging off",
  (value) => {
    // The operator asked for less logging; falling back to info would
    // give them the default amount instead.
    expect(resolveAppLogLevel(value)).toBe("silent");
  },
);

test("WARNING is honoured as warn", () => {
  // Python's spelling, and what MINER_LOG_LEVEL next door takes.
  expect(resolveAppLogLevel("WARNING")).toBe("warn");
});

test("case and surrounding whitespace do not matter", () => {
  expect(resolveAppLogLevel("  DEBUG  ")).toBe("debug");
  expect(resolveAppLogLevel("Silent")).toBe("silent");
  expect(resolveAppLogLevel(" Off ")).toBe("silent");
});

test("a nonsense level falls back rather than throwing", () => {
  // Read at boot in the composition root: a throw would turn a typo into
  // a backend that will not start.
  expect(resolveAppLogLevel("verbose")).toBe(APP_LOG_LEVEL);
  expect(resolveAppLogLevel("11")).toBe(APP_LOG_LEVEL);
});

test("the size defaults when unset", () => {
  expect(resolveAppLogMaxBytes(undefined)).toBe(APP_LOG_MAX_BYTES);
  // `Number("")` is 0, which must not read as a configured size.
  expect(resolveAppLogMaxBytes("")).toBe(APP_LOG_MAX_BYTES);
  expect(resolveAppLogMaxBytes("   ")).toBe(APP_LOG_MAX_BYTES);
});

test("a size is taken as given", () => {
  expect(resolveAppLogMaxBytes("1048576")).toBe(1_048_576);
});

test("a fractional size is floored", () => {
  expect(resolveAppLogMaxBytes("999999.9")).toBe(999_999);
});

test("too small a size clamps to the floor", () => {
  // Rotating every few lines would leave the two kept files unable to
  // hold even one session, which defeats having a durable log.
  expect(resolveAppLogMaxBytes("1")).toBe(APP_LOG_MIN_BYTES);
  // Zero is not "never rotate" -- an unbounded log file on a long-running
  // box is the failure this app already hit with the miner's own log.
  expect(resolveAppLogMaxBytes("0")).toBe(APP_LOG_MIN_BYTES);
});

test("a nonsense size falls back to the default", () => {
  expect(resolveAppLogMaxBytes("lots")).toBe(APP_LOG_MAX_BYTES);
  expect(resolveAppLogMaxBytes("-1")).toBe(APP_LOG_MAX_BYTES);
});
