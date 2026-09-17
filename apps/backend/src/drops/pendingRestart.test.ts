import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PendingRestart, RESTART_DEFERRAL_MS } from "./pendingRestart.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function make(restartImpl?: () => Promise<void>) {
  const restart = vi.fn(restartImpl ?? (async () => {}));
  const broadcast = vi.fn();
  const p = new PendingRestart({ supervisor: { restart }, broadcast });
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
