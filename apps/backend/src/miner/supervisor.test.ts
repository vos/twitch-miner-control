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
  // Tightened from `toBeLessThanOrEqual(1)`: the fast-exit path in onExit
  // returns before scheduleRestart is ever called, so restartCount must
  // stay at exactly 0. The old <=1 bound would pass even if backoff were
  // broken and incremented it once.
  expect(s.restartCount).toBe(0);
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

// --- Minor: restart() must not emit a spurious STOPPED ---
test("restart() does not emit a STOPPED state transition", async () => {
  const s = make("normal");
  await s.start();
  const seen: string[] = [];
  s.on("state", (state) => seen.push(state));
  await s.restart();
  expect(seen).not.toContain("STOPPED");
});

// --- Minor: setState must not re-emit an unchanged state ---
test("repeated stop() calls do not re-emit STOPPED once already stopped", async () => {
  const s = make("normal");
  await s.start();
  await s.stop();
  const seen: string[] = [];
  s.on("state", (state) => seen.push(state));
  await s.stop();
  await s.stop();
  await s.stop();
  expect(seen).toEqual([]);
});

test("stop after crash is a no-op, not an error", async () => {
  const s = make("instant");
  await s.start();
  await settle(400);
  await expect(s.stop()).resolves.toBeUndefined();
});

// --- Critical (1): stop() must be final, even mid-backoff ---
//
// FAKE_MODE=instant exits before fastExitMs and never reaches
// scheduleRestart's backoff sleep -- it can't reproduce this bug.
// FAKE_MODE=delayed_crash runs *past* fastExitMs (so onExit takes the
// "genuine crash" branch, not the "unstartable config" branch) and then
// exits on its own, landing squarely in the backoff/auto-restart path
// where this.child is null and a resurrect timer is in flight.
test("stop() during a post-fastExit backoff sleep prevents the pending auto-restart from resurrecting the miner", async () => {
  const s = make("delayed_crash", {
    fastExitMs: 100,
    env: { FAKE_MODE: "delayed_crash", DIE_AFTER_MS: "150" },
    backoffBaseMs: 300,
  });
  await s.start();
  await settle(200); // past DIE_AFTER_MS(150) and fastExitMs(100): the
                      // miner has crashed and scheduleRestart is now
                      // asleep in its ~300ms backoff window with
                      // this.child === null.
  await s.stop();
  expect(s.state).toBe("STOPPED");
  await settle(400); // past the backoff delay: if stop() failed to mark
                      // the pending restart as cancelled, spawnOnce()
                      // fires here and resurrects the miner.
  expect(s.state).toBe("STOPPED");
  expect(s.livePids().length).toBe(0);
});

// --- Important (4): a crashed-and-awaiting-restart miner must not
// report RUNNING ---
test("state is not RUNNING while backing off after a post-fastExit crash", async () => {
  const s = make("delayed_crash", {
    fastExitMs: 100,
    env: { FAKE_MODE: "delayed_crash", DIE_AFTER_MS: "150" },
    backoffBaseMs: 300,
  });
  await s.start();
  await settle(200); // crashed, now asleep in backoff with no live child
  expect(s.state).not.toBe("RUNNING");
  expect(s.livePids().length).toBe(0);
});

// --- Important (3): start() must not report RUNNING for an
// already-dead process ---
test.each([5, 45])(
  "start() does not resolve RUNNING when the miner dies %ims after spawn",
  async (dieAfterMs) => {
    const s = make("delayed_crash", {
      fastExitMs: 10_000, // stay well above dieAfterMs so this hits the
                           // spawn-race path, not the fastExit/CRASHED path
      env: { FAKE_MODE: "delayed_crash", DIE_AFTER_MS: String(dieAfterMs) },
    });
    await s.start();
    expect(s.state).not.toBe("RUNNING");
  },
);

// --- Important (2): restartCount must decay after a healthy run, not
// accumulate over the miner's lifetime ---
test("repeated healthy crash-recoveries do not exhaust the restart budget", async () => {
  // Each cycle runs well past the stability window before crashing again,
  // simulating a miner that recovers fine each time (e.g. a transient
  // Twitch disconnect) rather than crash-looping. With maxRestarts: 2,
  // a non-decaying counter would give up after the 3rd crash; with decay,
  // arbitrarily many *healthy* recoveries must never park in CRASHED.
  const s = make("delayed_crash", {
    fastExitMs: 50,
    backoffBaseMs: 10,
    maxRestarts: 2,
    stabilityMs: 100, // small override so a healthy stretch decays
                       // restartCount within a fast test, instead of
                       // requiring the real 5-minute default
    env: { FAKE_MODE: "delayed_crash", DIE_AFTER_MS: "120" },
  });
  await s.start();
  // 4 crash/recover cycles -- more than maxRestarts -- each followed by
  // a healthy run long enough to decay the counter before the next crash.
  for (let i = 0; i < 4; i++) {
    await settle(160); // past DIE_AFTER_MS(120): this cycle's miner crashes
    await settle(160); // past backoff + a healthy stretch of the respawn
  }
  expect(s.state).not.toBe("CRASHED");
});
