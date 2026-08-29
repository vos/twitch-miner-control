import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Supervisor } from "./supervisor.js";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "../../test/fixtures/fake-miner.mjs");

let sup: Supervisor;
afterEach(async () => { await sup?.stop(); });

function make(mode: string, overrides = {}) {
  sup = new Supervisor({
    command: process.execPath,
    args: [fake],
    cwd: process.cwd(),
    env: { FAKE_MODE: mode },
    graceMs: 300,
    fastExitMs: 500,
    backoffBaseMs: 10,
    maxRestarts: 3,
    ...overrides,
  });
  return sup;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("start moves through STARTING to RUNNING", async () => {
  const seen: string[] = [];
  const s = make("normal");
  s.on("state", (state) => seen.push(state));
  await s.start();
  expect(s.state).toBe("RUNNING");
  expect(seen).toContain("STARTING");
});

test("captures miner stdout into the log buffer", async () => {
  const s = make("normal");
  await s.start();
  await settle(100);
  expect(s.logs().join("\n")).toContain("miner started");
});

test("stop terminates a well-behaved miner with SIGTERM", async () => {
  const s = make("normal");
  await s.start();
  await s.stop();
  expect(s.state).toBe("STOPPED");
});

test("escalates to SIGKILL when SIGTERM is ignored", async () => {
  const s = make("stubborn");
  await s.start();
  const started = Date.now();
  await s.stop();
  expect(s.state).toBe("STOPPED");
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
});

test("a miner that exits immediately parks in CRASHED without looping", async () => {
  const s = make("instant");
  await s.start();
  await settle(400);
  expect(s.state).toBe("CRASHED");
  expect(s.restartCount).toBeLessThanOrEqual(1);
});

test("CRASHED surfaces the last log lines for diagnosis", async () => {
  const s = make("instant");
  await s.start();
  await settle(400);
  expect(s.logs().join("\n")).toContain("KeyError");
});

test("restart serializes so two callers cannot fork two miners", async () => {
  const s = make("normal");
  await s.start();
  await Promise.all([s.restart(), s.restart(), s.restart()]);
  expect(s.state).toBe("RUNNING");
  expect(s.livePids().length).toBe(1);
});

test("stop after crash is a no-op, not an error", async () => {
  const s = make("instant");
  await s.start();
  await settle(400);
  await expect(s.stop()).resolves.toBeUndefined();
});
