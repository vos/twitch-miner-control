import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PendingRestart, RESTART_DEFERRAL_MS } from "./pendingRestart.js";
import { memoryLog } from "../appLog/memory.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function make(restartImpl?: () => Promise<void>, log?: ReturnType<typeof memoryLog>) {
  const restart = vi.fn(restartImpl ?? (async () => {}));
  const broadcast = vi.fn();
  const p = new PendingRestart({ supervisor: { restart }, broadcast, log });
  return { p, restart, broadcast };
}

test("a proposal does not restart immediately", () => {
  const { p, restart } = make();
  p.propose("pool changed");
  expect(restart).not.toHaveBeenCalled();
  expect(p.state().pending).toBe(true);
  expect(p.state().reason).toBe("pool changed");
});

test("the restart fires once the deferral elapses", async () => {
  const { p, restart } = make();
  p.propose("pool changed");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(restart).toHaveBeenCalledTimes(1);
  expect(p.state().pending).toBe(false);
});

test("an unattended timer still fires", async () => {
  // Deliberate: waiting for a human would mean subscriptions silently
  // stop working on a box nobody is watching, which is the normal case
  // for this app.
  const { p, restart } = make();
  p.propose("pool changed");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS * 3);
  expect(restart).toHaveBeenCalledTimes(1);
});

test("cancel stops that restart", async () => {
  const { p, restart } = make();
  p.propose("pool changed");
  p.cancel();
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS * 2);
  expect(restart).not.toHaveBeenCalled();
  expect(p.state().pending).toBe(false);
});

test("cancel does not block a later proposal", async () => {
  // A cancel is "not right now", not "never".
  const { p, restart } = make();
  p.propose("pool changed");
  p.cancel();
  p.propose("pool changed again");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(restart).toHaveBeenCalledTimes(1);
});

test("fireNow restarts without waiting", async () => {
  const { p, restart } = make();
  p.propose("pool changed");
  await p.fireNow();
  expect(restart).toHaveBeenCalledTimes(1);
  expect(p.state().pending).toBe(false);
});

test("fireNow cancels the pending timer rather than doubling up", async () => {
  const { p, restart } = make();
  p.propose("pool changed");
  await p.fireNow();
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS * 2);
  expect(restart).toHaveBeenCalledTimes(1);
});

test("a second proposal does not stack a second timer", async () => {
  const { p, restart } = make();
  p.propose("one");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS / 2);
  p.propose("two");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(restart).toHaveBeenCalledTimes(1);
});

test("a second proposal does not push the deadline out", async () => {
  // Otherwise a flapping resolution defers the restart forever and the
  // subscriptions never take effect.
  const { p } = make();
  p.propose("one");
  const first = p.state().dueAt;
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS / 2);
  p.propose("two");
  expect(p.state().dueAt).toBe(first);
});

test("state changes are broadcast so the banner can follow", () => {
  const { p, broadcast } = make();
  p.propose("pool changed");
  expect(broadcast).toHaveBeenCalledWith(
    "pending-restart",
    expect.objectContaining({ pending: true, reason: "pool changed" }),
  );
});

test("a cancel is broadcast too, so the banner clears", () => {
  const { p, broadcast } = make();
  p.propose("pool changed");
  broadcast.mockClear();
  p.cancel();
  expect(broadcast).toHaveBeenCalledWith(
    "pending-restart",
    expect.objectContaining({ pending: false }),
  );
});

test("a failed restart clears the pending state rather than wedging", async () => {
  // The miner keeps running the previous config, which is still
  // collecting; the next pass proposes again.
  const { p } = make(async () => { throw new Error("supervisor exploded"); });
  p.propose("pool changed");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(p.state().pending).toBe(false);
});

test("nothing is pending before anything is proposed", () => {
  const { p } = make();
  expect(p.state()).toEqual({ pending: false, dueAt: null, reason: null });
});

test("records a proposal with its deadline", () => {
  const log = memoryLog();
  const { p } = make(undefined, log);
  p.propose("drop subscriptions resolved new channels");
  const event = log.ofType("restart.proposed")[0];
  expect(event?.renewed).toBe(false);
  expect(event?.reason).toBe("drop subscriptions resolved new channels");
  expect(typeof event?.dueAt).toBe("number");
});

test("a second proposal is recorded as a renewal, not a new deadline", () => {
  // The deadline deliberately does not move; the log has to say so, or a
  // reader seeing two proposals would expect the restart to have slipped.
  const log = memoryLog();
  const { p } = make(undefined, log);
  p.propose("first");
  const dueAt = log.ofType("restart.proposed")[0]?.dueAt;
  p.propose("second");
  const renewal = log.ofType("restart.proposed")[1];
  expect(renewal?.renewed).toBe(true);
  expect(renewal?.dueAt).toBe(dueAt);
});

test("records the user's veto with how long was left", () => {
  const log = memoryLog();
  const { p } = make(undefined, log);
  p.propose("a drop campaign ended");
  p.cancel();
  const event = log.ofType("user.restart.cancelled")[0];
  expect(event?.reason).toBe("a drop campaign ended");
  expect(typeof event?.remainingMs).toBe("number");
});

test("cancelling nothing records nothing", () => {
  // Only a real veto is a decision; a no-op cancel is not.
  const log = memoryLog();
  const { p } = make(undefined, log);
  p.cancel();
  expect(log.ofType("user.restart.cancelled")).toEqual([]);
});

test("records the restart firing", async () => {
  const log = memoryLog();
  const { p } = make(undefined, log);
  p.propose("a drop campaign ended");
  await p.fireNow();
  expect(log.ofType("restart.fired")[0]?.reason).toBe("a drop campaign ended");
});

test("records a restart that failed", async () => {
  // Currently a silent catch: the miner stays on the previous config and
  // nothing tells anyone the restart did not happen.
  const log = memoryLog();
  const { p } = make(() => Promise.reject(new Error("spawn failed")), log);
  p.propose("a drop campaign ended");
  await p.fireNow();
  expect(log.ofType("restart.failed")[0]?.err).toBe("spawn failed");
});

// --- deferral and transitions, for notifications ---

test("the deferral comes from deferralMs when one is given", async () => {
  const restart = vi.fn(async () => {});
  const p = new PendingRestart({ supervisor: { restart }, deferralMs: () => 180_000 });
  const t0 = Date.now();
  p.propose("pool changed");
  expect(p.state().dueAt).toBe(t0 + 180_000);
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(restart).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(180_000 - RESTART_DEFERRAL_MS);
  expect(restart).toHaveBeenCalledTimes(1);
});

test("a proposal and its firing are reported; a renewal is not", async () => {
  const transitions: unknown[] = [];
  const p = new PendingRestart({
    supervisor: { restart: async () => {} }, onTransition: (t) => transitions.push(t),
  });
  const t0 = Date.now();
  p.propose("pool changed");
  p.propose("pool changed again");
  await vi.advanceTimersByTimeAsync(RESTART_DEFERRAL_MS);
  expect(transitions).toEqual([
    { phase: "proposed", reason: "pool changed", dueAt: t0 + RESTART_DEFERRAL_MS },
    { phase: "fired", reason: "pool changed again", ok: true },
  ]);
});

test("a cancel reports where it came from; cancelling nothing reports nothing", () => {
  const transitions: unknown[] = [];
  const p = new PendingRestart({
    supervisor: { restart: async () => {} }, onTransition: (t) => transitions.push(t),
  });
  p.propose("pool changed");
  p.cancel("notification");
  p.cancel();
  expect(transitions).toHaveLength(2);
  expect(transitions[1]).toEqual({ phase: "cancelled", reason: "pool changed", via: "notification" });
});

test("a failed restart is reported as fired but not ok", async () => {
  const transitions: unknown[] = [];
  const p = new PendingRestart({
    supervisor: { restart: async () => { throw new Error("spawn failed"); } },
    onTransition: (t) => transitions.push(t),
  });
  p.propose("pool changed");
  await p.fireNow();
  expect(transitions.at(-1)).toEqual({ phase: "fired", reason: "pool changed", ok: false });
});

test("fireNow with nothing pending reports nothing", async () => {
  const onTransition = vi.fn();
  const p = new PendingRestart({ supervisor: { restart: async () => {} }, onTransition });
  await p.fireNow();
  expect(onTransition).not.toHaveBeenCalled();
});
