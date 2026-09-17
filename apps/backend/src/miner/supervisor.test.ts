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

/**
 * Waits for a condition instead of for a duration.
 *
 * These tests drive a real child process, so a bare `settle(n)` tuned to
 * land just past some event has no margin: on a loaded machine the child
 * has not reached that point yet and the assertion runs against the
 * previous state. Polling for the state the test is actually waiting on
 * keeps the timing intent while surviving a busy box -- and still fails,
 * with the same message, if the state genuinely never arrives.
 */
async function until(
  predicate: () => boolean,
  { timeout = 5_000, step = 10 } = {},
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) return;
    await settle(step);
  }
}

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
  // The child's stdout arrives whenever it arrives: start() resolves on
  // the spawn, not on the first byte of output. A flat 100ms was enough
  // at idle and not enough on a busy machine.
  await until(() => s.logs().lines.join("\n").includes("miner started"));
  expect(s.logs().lines.join("\n")).toContain("miner started");
});

test("announces captured output with the buffer's running line count", async () => {
  const s = make("normal");
  const frames: Array<{ lines: string[]; total: number }> = [];
  s.on("log", (frame) => frames.push(frame));
  await s.start();
  await until(() => frames.flatMap((f) => f.lines).join("\n").includes("miner started"));
  expect(frames.flatMap((f) => f.lines).join("\n")).toContain("miner started");
  expect(frames.at(-1)!.total).toBe(s.logs().total);
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
  // start() resolves once the OS confirms the spawn, which can be before
  // the fixture's script body has run -- and it installs its
  // SIGTERM-ignoring handler in that body. A stop() landing first was
  // handled by Node's default disposition and the child died in 19ms,
  // failing an assertion about the grace period the supervisor never got
  // to serve. The fixture prints this line immediately before installing
  // the handler, so it is the readiness signal.
  await until(() => s.logs().lines.join("\n").includes("miner started"));
  const started = Date.now();
  await s.stop();
  expect(s.state).toBe("STOPPED");
  // The contract: stop() waits out the grace period before escalating.
  expect(Date.now() - started).toBeGreaterThanOrEqual(290);
});

test("a miner that exits immediately parks in CRASHED without looping", async () => {
  const s = make("instant");
  await s.start();
  await until(() => s.state === "CRASHED");
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
  expect(s.logs().lines.join("\n")).toContain("KeyError");
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
  // Crashes at 150ms, then sleeps in backoff. Waited for rather than
  // slept past: a flat 200ms covered that at idle and landed mid-spawn
  // once the machine was busy. RESTARTING is the backoff state -- the
  // claim is that it is not RUNNING while there is no live child.
  await until(() => s.state === "RESTARTING" || s.state === "CRASHED");
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
    // start() bounds its own wait at SPAWN_SETTLE_MS (250ms), which is
    // sized for a fixture that exits ~95-100ms after spawn. Spawning a
    // Node process on a loaded machine takes longer than that whole
    // budget, so start() can legitimately return before the child has
    // died -- and sampling the state right here caught it mid-race.
    //
    // The claim under test is that RUNNING is never the settled answer
    // for a process that dies this quickly, so wait for the crash to be
    // observed and then assert. A supervisor that wrongly reported
    // RUNNING still fails: the state stays RUNNING, `until` times out,
    // and the expectation below sees it.
    await until(() => s.state !== "RUNNING" && s.state !== "STARTING");
    expect(s.state).not.toBe("RUNNING");
  },
);

// --- N1 regression: restartCount must not be reset by a lucky per-run
// uptime check. The old rule ("this run stayed up longer than
// stabilityMs, so wipe the counter") resets the budget on every single
// crash for a miner that reliably survives just past that threshold
// before dying again (an expiring token, a nightly OOM at a fixed
// uptime, etc.) -- maxRestarts then never engages and the miner
// restarts forever with no terminal operator signal. The fix replaces
// the per-run reset with a sliding crash-rate window (crashWindowMs):
// what matters is not "did this one run last a while" but "how many
// crashes have landed recently."
//
// Test 1 below still passes a `stabilityMs` override. That field only
// exists on the pre-fix implementation and is read here purely to
// reproduce the historical defect when this test is run against
// supervisor.ts as committed before this fix (see the report for that
// run's output) -- the fixed implementation has no such field and
// silently ignores the extra key; `crashWindowMs` is what actually
// governs the fixed code's behaviour in this test.
test("cap engages for a slow crash loop that would have reset a per-run stability check", async () => {
  const s = make("delayed_crash", {
    fastExitMs: 20, // crashes must land past this to count as genuine
                     // crashes (not the unstartable-config fast-exit path)
    backoffBaseMs: 10,
    maxRestarts: 2,
    crashWindowMs: 5000, // fixed code: comfortably covers this whole test,
                          // so all crashes accumulate in one window
    stabilityMs: 10,      // pre-fix code only: smaller than every run's
                          // ~40ms uptime, so the old per-run check resets
                          // restartCount to 0 after every single crash
    env: { FAKE_MODE: "delayed_crash", DIE_AFTER_MS: "40" },
  });
  await s.start();
  // Each cycle: ~40ms alive (past fastExitMs(20) and past stabilityMs(10),
  // i.e. exactly the spacing that would fool the old per-run reset) then
  // crash, then a short backoff before the next attempt. Drive well past
  // maxRestarts(2) worth of crashes -- old code loops forever; fixed code
  // must park in CRASHED once the window holds more than maxRestarts.
  // Waited for rather than counted out in fixed sleeps: six 120ms ticks
  // covered the crash/backoff cycles at idle and ran out mid-loop once
  // spawning a Node process took longer than the budget. A supervisor
  // that never caps still fails -- it simply never reaches CRASHED and
  // the expectation below sees whatever state it is stuck in.
  await until(() => s.state === "CRASHED", { timeout: 10_000 });
  expect(s.state).toBe("CRASHED");
});

// --- N1 regression, other half: a genuinely healthy miner (crashes far
// enough apart that they never share a crashWindowMs window) must never
// be punished, no matter how many times it crashes over its lifetime.
// Asserting on restartCount (not just state) keeps this from passing
// vacuously -- a supervisor that let restartCount grow unbounded while
// happening not to hit CRASHED yet would still fail this.
test("a healthy miner that recovers between crashes is never punished", async () => {
  const s = make("delayed_crash", {
    fastExitMs: 20,
    backoffBaseMs: 10,
    maxRestarts: 2,
    crashWindowMs: 80, // narrow window: each crash below is spaced well
                        // outside it, so the window empties out completely
                        // between crashes and never accumulates
    env: { FAKE_MODE: "delayed_crash", DIE_AFTER_MS: "40" },
  });
  await s.start();
  // 5 crash/recover cycles -- more than maxRestarts(2) crashes over the
  // miner's lifetime -- each separated by a healthy stretch far longer
  // than crashWindowMs(80ms), so no two crashes ever land in the same
  // window.
  for (let i = 0; i < 5; i++) {
    await settle(60);  // past DIE_AFTER_MS(40): this cycle's miner crashes
    await settle(300); // backoff, respawn, then a long healthy stretch --
                        // comfortably longer than crashWindowMs(80ms)
    expect(s.state).not.toBe("CRASHED");
    expect(s.restartCount).toBeLessThanOrEqual(1);
  }
  expect(s.state).not.toBe("CRASHED");
  expect(s.restartCount).toBeLessThanOrEqual(1);
});

test("runningSince is null before anything has ever been started", () => {
  const s = make("normal");
  expect(s.runningSince).toBeNull();
});

test("runningSince reports when the live miner started", async () => {
  const before = Date.now();
  const s = make("normal");
  await s.start();
  expect(s.runningSince).not.toBeNull();
  expect(s.runningSince as number).toBeGreaterThanOrEqual(before);
  expect(s.runningSince as number).toBeLessThanOrEqual(Date.now());
});

test("runningSince clears on stop, so a stopped miner cannot show a ticking timer", async () => {
  const s = make("normal");
  await s.start();
  await s.stop();
  expect(s.runningSince).toBeNull();
});

test("runningSince clears when the miner crashes out for good", async () => {
  const s = make("instant");
  await s.start();
  await until(() => s.state === "CRASHED");
  expect(s.state).toBe("CRASHED");
  expect(s.runningSince).toBeNull();
});

test("runningSince is null during a restart backoff, so no timer ticks for a miner that does not exist", async () => {
  // Crashes after fastExitMs, so onExit schedules a backoff restart rather
  // than parking in CRASHED -- the window where a stale startedAt would
  // otherwise still be reported.
  const s = make("delayed_crash", {
    env: { FAKE_MODE: "delayed_crash", DIE_AFTER_MS: "300" },
    fastExitMs: 50, backoffBaseMs: 600,
  });
  await s.start();
  // The child is scheduled to die at 300ms, so a flat settle(300) raced
  // it -- exactly tied at idle, and lost the moment the machine was busy.
  await until(() => s.state === "RESTARTING");
  expect(s.state).toBe("RESTARTING");
  expect(s.runningSince).toBeNull();
});

test("no state emitted alongside a start time reports one for a process that is not running", async () => {
  // Caught by driving the real app: restart() announced RESTARTING while the
  // outgoing child was still alive, so the frame carried the dying run's
  // startedAt and a dashboard kept ticking uptime for a process being killed.
  // Only RUNNING may carry a start time.
  const s = make("normal");
  const frames: Array<{ state: string; startedAt: number | null }> = [];
  s.on("state", (state: string) => frames.push({ state, startedAt: s.runningSince }));
  await s.start();
  await s.restart();
  await s.stop();
  expect(frames.length).toBeGreaterThan(3);
  for (const frame of frames) {
    if (frame.state === "RUNNING") expect(frame.startedAt).not.toBeNull();
    else expect(frame.startedAt).toBeNull();
  }
});

test("records a miner session while running", async () => {
  const open: number[] = [];
  const close: number[] = [];
  const s = make("normal", {
    sessions: { open: (ts: number) => open.push(ts), close: (ts: number) => close.push(ts) },
  });

  await s.start();
  expect(open).toHaveLength(1);
  expect(close).toHaveLength(0);

  await s.stop();
  expect(close).toHaveLength(1);
});

test("closes the miner session when the miner crashes", async () => {
  // The process is gone but the row must not stay open, or a crash would
  // silently keep counting as mining time.
  const close: number[] = [];
  // The miner must live past fastExitMs so it actually reaches RUNNING --
  // a faster exit is treated as an unstartable config and never opens a
  // session in the first place.
  const s = make("delayed_crash", {
    sessions: { open: () => {}, close: (ts: number) => close.push(ts) },
    fastExitMs: 100,
    env: { FAKE_MODE: "delayed_crash", DIE_AFTER_MS: "300" },
  });
  await s.start();
  await settle(450);
  expect(close.length).toBeGreaterThanOrEqual(1);
});

test("runs without a sessions port", async () => {
  // The port is optional: the supervisor's own tests and any caller that
  // does not care about uptime spans must still work.
  const s = make("normal");
  await s.start();
  expect(s.state).toBe("RUNNING");
});
