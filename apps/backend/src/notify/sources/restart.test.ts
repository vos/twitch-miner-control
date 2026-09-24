import { expect, test, vi } from "vitest";
import { RESTART_DEFERRAL_MS } from "../../drops/pendingRestart.js";
import { ActionTokens } from "../actions.js";
import { NOTIFIED_DEFERRAL_MS, RestartNotifications } from "./restart.js";

function harness(wants = true) {
  const publish = vi.fn();
  const state = { pending: true, dueAt: 5_000 as number | null, reason: "x" as string | null };
  const cancel = vi.fn();
  const notes = new RestartNotifications({
    notifier: { publish, wantsAny: () => wants },
    tokens: new ActionTokens(() => 1_000),
    pending: () => ({ state: () => state, cancel }),
  });
  return { notes, publish, state, cancel };
}

test("the deferral is longer when someone will be told", () => {
  expect(harness(true).notes.deferralMs()).toBe(NOTIFIED_DEFERRAL_MS);
  expect(harness(false).notes.deferralMs()).toBe(RESTART_DEFERRAL_MS);
});

test("a proposal is published with its due time and a Cancel action", () => {
  const { notes, publish } = harness();
  notes.onTransition({ phase: "proposed", reason: "drop subscriptions resolved new channels", dueAt: 5_000 });
  expect(publish).toHaveBeenCalledWith({
    kind: "restart.pending", title: "Miner restart pending",
    body: "Drop subscriptions resolved new channels. Cancel to keep watching the current channels.",
    link: "/?open=dashboard", tag: "restart", dueAt: 5_000,
    actions: [{ id: "cancel-restart", title: "Cancel restart", token: expect.stringMatching(/^[0-9a-f]{64}$/) }],
  });
});

test("the action's token cancels that restart, once", () => {
  const { notes, publish, cancel } = harness();
  notes.onTransition({ phase: "proposed", reason: "r", dueAt: 5_000 });
  const token = publish.mock.calls[0][0].actions[0].token as string;
  expect(notes.redeem(token)).toBe(true);
  expect(cancel).toHaveBeenCalledWith("notification");
  expect(notes.redeem(token)).toBe(false);
});

test("a token cannot cancel a later restart", () => {
  const { notes, publish, state, cancel } = harness();
  notes.onTransition({ phase: "proposed", reason: "r", dueAt: 5_000 });
  const token = publish.mock.calls[0][0].actions[0].token as string;
  state.dueAt = 9_000;
  expect(notes.redeem(token)).toBe(false);
  expect(cancel).not.toHaveBeenCalled();
});

test("nothing pending means nothing to cancel", () => {
  const { notes, publish, state } = harness();
  notes.onTransition({ phase: "proposed", reason: "r", dueAt: 5_000 });
  state.pending = false;
  expect(notes.redeem(publish.mock.calls[0][0].actions[0].token)).toBe(false);
});

test("cancellation and firing are follow-ups on the same tag", () => {
  const { notes, publish } = harness();
  notes.onTransition({ phase: "cancelled", reason: "r", via: "notification" });
  notes.onTransition({ phase: "fired", reason: "drop subscriptions resolved new channels", ok: true });
  notes.onTransition({ phase: "fired", reason: "r", ok: false });
  expect(publish.mock.calls.map(([n]) => [n.title, n.tag, n.followUp])).toEqual([
    ["Restart cancelled", "restart", true],
    ["Miner restarted", "restart", true],
    ["Restart failed", "restart", true],
  ]);
  expect(publish.mock.calls[0][0].body).toMatch(/^Cancelled from a notification\./);
});
