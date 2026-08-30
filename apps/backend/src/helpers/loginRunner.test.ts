import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { LoginRunner, type LoginProgress } from "./loginRunner.js";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "../../test/fixtures/fake-login.mjs");
const stubborn = join(here, "../../test/fixtures/stubborn-login.mjs");

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(env: Record<string, string> = {}) {
  const runner = new LoginRunner({
    command: process.execPath, args: [fake], cwd: process.cwd(), env,
  });
  const seen: LoginProgress[] = [];
  runner.on("progress", (p) => seen.push(p));
  return new Promise<LoginProgress[]>((resolve) => {
    runner.on("done", () => resolve(seen));
    runner.start();
  });
}

test("emits the device code for the UI to display", async () => {
  const seen = await run();
  expect(seen[0]).toEqual({
    stage: "code", userCode: "ABCD1234",
    verificationUri: "https://www.twitch.tv/activate", expiresAt: 999,
  });
});

test("reaches ok on success", async () => {
  expect((await run()).at(-1)).toEqual({ stage: "ok", username: "alex" });
});

test("surfaces an error stage on failure", async () => {
  const last = (await run({ FAKE_LOGIN: "fail" })).at(-1);
  expect(last).toEqual({ stage: "error", error: "token rejected by Twitch" });
});

test("current exposes the latest progress for late subscribers", async () => {
  const runner = new LoginRunner({
    command: process.execPath, args: [fake], cwd: process.cwd(), env: {},
  });
  await new Promise<void>((resolve) => {
    runner.on("done", () => resolve());
    runner.start();
  });
  expect(runner.current).toEqual({ stage: "ok", username: "alex" });
});

// Correction 5: a line whose "stage" is not a recognised LoginProgress
// variant must be discarded exactly like malformed JSON, never presented
// to consumers (via "progress" or `current`) as valid progress.
test("discards a line with an unrecognised stage instead of emitting it", async () => {
  const seen = await run({ FAKE_LOGIN: "badstage" });
  for (const p of seen) {
    expect(["code", "pending", "ok", "error"]).toContain(p.stage);
  }
  expect(seen.at(-1)).toEqual({ stage: "ok", username: "alex" });
});

// Correction 1: a spawn failure (bad interpreter path, non-executable
// helper, ...) emits "error" and never "exit". Without a dedicated
// "error" handler, `current` stays null, "progress" never fires, and
// "done" never fires -- an HTTP request awaiting login completion would
// hang forever. This must reach a terminal error and fire "done" exactly
// once, without relying on a timeout to prove it.
test("surfaces a spawn failure as a terminal error instead of hanging", async () => {
  const runner = new LoginRunner({
    command: "/nonexistent/definitely-not-a-real-binary",
    args: [],
    cwd: process.cwd(),
    env: {},
  });
  let doneCount = 0;
  runner.on("done", () => { doneCount += 1; });
  await new Promise<void>((resolve) => {
    runner.on("done", () => resolve());
    runner.start();
  });
  expect(runner.current?.stage).toBe("error");
  expect((runner.current as { error: string }).error).toMatch(/./);
  // Give any stray duplicate "exit" event a chance to fire before we
  // assert the count stayed at exactly one.
  await settle(50);
  expect(doneCount).toBe(1);
});

// Correction 2: a helper that floods stderr past the OS pipe's ~64KB
// buffer must not deadlock the runner (which would otherwise never read
// it), and the collected (tail-capped) text should end up in the
// synthesized error message so an operator can diagnose a failed login
// from a Python traceback.
test("drains stderr and surfaces its tail when the helper dies silently", async () => {
  const seen = await run({ FAKE_LOGIN: "stderr-flood" });
  const last = seen.at(-1);
  expect(last?.stage).toBe("error");
  expect((last as { error: string }).error).toContain("TRACEBACK_MARKER_END");
});

// Correction 3: cancel() must escalate to SIGKILL if the helper ignores
// SIGTERM, matching apps/backend/src/miner/supervisor.ts's approach.
test("cancel escalates to SIGKILL when the helper ignores SIGTERM", async () => {
  const runner = new LoginRunner({
    command: process.execPath, args: [stubborn], cwd: process.cwd(), env: {},
    graceMs: 200,
  });
  const done = new Promise<void>((resolve) => runner.on("done", () => resolve()));
  // Wait for the fixture's first real progress line instead of a fixed
  // sleep. In stubborn-login.mjs, `process.on("SIGTERM", ...)` is
  // registered before that line is ever emitted, so observing this event
  // guarantees the handler is already armed in the child. A fixed sleep
  // here was not a reliable proxy for that: under CPU contention a freshly
  // spawned node child can take longer than the sleep just to start
  // interpreting its script, so cancel() could fire before the handler was
  // registered -- letting SIGTERM's default (kill-immediately) action tear
  // the child down well under the grace period and making this test flaky
  // under load rather than actually exercising the SIGKILL escalation.
  const firstProgress = new Promise<void>((resolve) => {
    runner.once("progress", () => resolve());
  });
  runner.start();
  await firstProgress;
  const started = Date.now();
  runner.cancel();
  await done;
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  expect(runner.current?.stage).toBe("error");
});

// Correction 3: cancel() before start(), or after the child has already
// exited, must be a safe no-op -- never throw, never leave a dangling
// timer.
test("cancel is a safe no-op before start and after exit", async () => {
  const neverStarted = new LoginRunner({
    command: process.execPath, args: [fake], cwd: process.cwd(), env: {},
  });
  expect(() => neverStarted.cancel()).not.toThrow();

  const finished = new LoginRunner({
    command: process.execPath, args: [fake], cwd: process.cwd(), env: {},
  });
  await new Promise<void>((resolve) => {
    finished.on("done", () => resolve());
    finished.start();
  });
  expect(() => finished.cancel()).not.toThrow();
});

// cancel() sets a killTimer to escalate to SIGKILL if the grace period
// elapses. Calling it twice while the child is still alive used to
// overwrite `killTimer` without clearing the previous one first, orphaning
// that first timer with no reference anyone could clear -- it stayed
// scheduled and fired on its own regardless of what the second call did.
test("cancel() twice clears the first timer instead of orphaning it", async () => {
  const runner = new LoginRunner({
    command: process.execPath, args: [stubborn], cwd: process.cwd(), env: {},
    graceMs: 200,
  });
  const firstProgress = new Promise<void>((resolve) => {
    runner.once("progress", () => resolve());
  });
  runner.start();
  await firstProgress;

  const clearSpy = vi.spyOn(global, "clearTimeout");
  runner.cancel();
  const firstTimer = (runner as unknown as { killTimer: unknown }).killTimer;
  expect(firstTimer).not.toBeNull();
  runner.cancel();
  expect(clearSpy).toHaveBeenCalledWith(firstTimer);
  clearSpy.mockRestore();

  // Let the (second, non-orphaned) timer actually escalate to SIGKILL so
  // the stubborn child -- which ignores SIGTERM -- is cleaned up rather
  // than leaked past this test.
  const done = new Promise<void>((resolve) => runner.on("done", () => resolve()));
  await done;
  expect(runner.current?.stage).toBe("error");
});

// Correction: the missing regression test for a clean cancel -> exit --
// killTimer must be cleared once the child actually exits, not left
// dangling to fire a SIGKILL at an already-gone process later.
test("a clean cancel-to-exit clears the kill timer rather than leaving it to fire later", async () => {
  const runner = new LoginRunner({
    // fake-login.mjs registers no SIGTERM handler, so the default action
    // (immediate termination) applies -- well under the long graceMs
    // below, proving the timer is cleared by the exit, not by expiring.
    command: process.execPath, args: [fake], cwd: process.cwd(), env: {},
    graceMs: 5_000,
  });
  const firstProgress = new Promise<void>((resolve) => {
    runner.once("progress", () => resolve());
  });
  runner.start();
  await firstProgress;

  const done = new Promise<void>((resolve) => runner.on("done", () => resolve()));
  runner.cancel();
  await done;
  expect((runner as unknown as { killTimer: unknown }).killTimer).toBeNull();
});
