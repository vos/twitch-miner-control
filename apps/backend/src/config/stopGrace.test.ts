import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { STOP_GRACE_MS } from "../miner/supervisor.js";
import { resolveStopGraceMs } from "./stopGrace.js";

describe("STOP_GRACE_MS", () => {
  // A stalled request in the miner's watch loop blocks for 23.05s (3.05s
  // connect + 20s read timeout), and that loop works through two watch
  // slots without checking for shutdown. On top of that comes the 5s sleep
  // step the other background threads poll on.
  test("outlasts two stalled watch requests", () => {
    expect(STOP_GRACE_MS).toBeGreaterThan(2 * 23_050 + 5_000);
  });

  // Docker's stop_grace_period is the outer deadline: if it is not longer
  // than ours, Docker kills the container during a shutdown still in progress.
  test.each(["compose.yaml", "compose.prod.yaml"])(
    "%s gives the backend longer than the miner's grace period",
    (file) => {
      const url = new URL(`../../../../${file}`, import.meta.url);
      const match = /stop_grace_period: (\d+)s/.exec(readFileSync(url, "utf8"));
      expect(Number(match?.[1]) * 1000).toBeGreaterThan(STOP_GRACE_MS);
    },
  );
});

describe("resolveStopGraceMs", () => {
  test("defaults to the supervisor's production grace period", () => {
    expect(resolveStopGraceMs(undefined)).toBe(STOP_GRACE_MS);
  });

  test("accepts an explicit override in milliseconds", () => {
    expect(resolveStopGraceMs("2000")).toBe(2000);
  });

  // 0 means "SIGKILL immediately"; it is a meaningful setting for a dev
  // loop that never wants to wait on the miner's thread joins, so it must
  // survive rather than being treated as absent by a falsy check.
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
