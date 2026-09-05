import { describe, expect, test } from "vitest";
import { STOP_GRACE_MS } from "../miner/supervisor.js";
import { resolveStopGraceMs } from "./stopGrace.js";

describe("resolveStopGraceMs", () => {
  test("defaults to the supervisor's production grace period", () => {
    expect(resolveStopGraceMs(undefined)).toBe(STOP_GRACE_MS);
  });

  test("accepts an explicit override in milliseconds", () => {
    expect(resolveStopGraceMs("2000")).toBe(2000);
  });

  // 0 means "SIGKILL immediately"; it is a meaningful setting for a dev
  // loop that never wants to wait on the miner's ~15s thread joins, so it
  // must survive rather than being treated as absent by a falsy check.
  test("keeps an explicit zero instead of falling back to the default", () => {
    expect(resolveStopGraceMs("0")).toBe(0);
  });

  // A typo in .env must not silently disable the SIGKILL escalation and
  // leave a miner holding Twitch cookies alive forever.
  test.each(["", "abc", "-1", "1.5e400", "NaN"])(
    "falls back to the default for invalid value %j",
    (value) => {
      expect(resolveStopGraceMs(value)).toBe(STOP_GRACE_MS);
    },
  );
});
