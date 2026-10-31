import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import {
  ERROR_NOTIFY_EVERY_MS, PREDICTION_FAILED_NOTIFY_EVERY_MS, watchDoorbell,
} from "./doorbell.js";

test("notable miner events are published with the miner's own words", () => {
  const publish = vi.fn();
  const stateService = new EventEmitter();
  watchDoorbell({ notifier: { publish }, stateService });
  stateService.emit("event", { ts: 1, type: "PREDICTION_WIN", message: "Won 100" });
  stateService.emit("event", { ts: 2, type: "GIFT_SUB_RECEIVED", message: null });
  stateService.emit("event", { ts: 3, type: "GAIN_FOR_WATCH", message: "+10" });
  expect(publish.mock.calls.map(([n]) => [n.kind, n.title, n.body])).toEqual([
    ["prediction.won", "Prediction won", "Won 100"],
    ["gift.received", "Gift sub received", "Gift sub received"],
  ]);
});

test("a noisy error source cannot hide another's error", () => {
  // Every failed Twitch request reports an error, and an outage fails them
  // all, which must not use up the notice a rarer failure would get.
  const publish = vi.fn();
  const stateService = new EventEmitter();
  let now = 0;
  watchDoorbell({ notifier: { publish }, stateService, now: () => now });
  const error = (context: string) =>
    stateService.emit("event", { ts: now, type: "ERROR", message: context, context });
  error("Twitch API");
  now += 1000;
  error("Twitch API");
  error("Drops Claimer");
  expect(publish.mock.calls.map(([n]) => [n.body, n.tag])).toEqual([
    ["Twitch API", "miner-error:Twitch API"],
    ["Drops Claimer", "miner-error:Drops Claimer"],
  ]);
});

test("each error source counts what it held back on its own", () => {
  const publish = vi.fn();
  const stateService = new EventEmitter();
  let now = 0;
  watchDoorbell({ notifier: { publish }, stateService, now: () => now });
  const error = (context: string) =>
    stateService.emit("event", { ts: now, type: "ERROR", message: context, context });
  error("Twitch API");
  error("Drops Claimer");
  error("Twitch API");
  now += ERROR_NOTIFY_EVERY_MS;
  error("Twitch API");
  expect(publish.mock.calls.at(-1)?.[0].body).toBe("Twitch API (1 more since the last notice)");
});

test("a claim attempt is not announced as a claim", () => {
  // The miner sends this before it tries, and retries what Twitch refuses.
  // Verified claims are announced from the inventory; see dropClaims.ts.
  const publish = vi.fn();
  const stateService = new EventEmitter();
  watchDoorbell({ notifier: { publish }, stateService });
  stateService.emit("event", { ts: 1, type: "DROP_CLAIM", message: "Claim Drop 1" });
  expect(publish).not.toHaveBeenCalled();
});

test("a refused prediction says what to do about the terms", () => {
  const publish = vi.fn();
  const stateService = new EventEmitter();
  watchDoorbell({ notifier: { publish }, stateService });
  stateService.emit("event", {
    ts: 1, type: "PREDICTION_FAILED", message: "raw", errorCode: "MUST_ACCEPT_TOS",
  });
  const [n] = publish.mock.calls[0];
  expect([n.kind, n.title]).toEqual(["prediction.failed", "Prediction failed"]);
  expect(n.body).toContain("terms");
});

test("a failure with no known advice shows the miner's words and the code", () => {
  const publish = vi.fn();
  const stateService = new EventEmitter();
  watchDoorbell({ notifier: { publish }, stateService });
  stateService.emit("event", { ts: 1, type: "PREDICTION_FAILED", message: "Failed", errorCode: "ODD" });
  expect(publish.mock.calls[0][0].body).toBe("Failed (ODD)");
});

test("each prediction failure notifies once per interval, per code", () => {
  // The same refusal comes back on every bet, for as long as it lasts.
  const publish = vi.fn();
  const stateService = new EventEmitter();
  let now = 0;
  watchDoorbell({ notifier: { publish }, stateService, now: () => now });
  const fail = (errorCode: string) =>
    stateService.emit("event", { ts: now, type: "PREDICTION_FAILED", message: "x", errorCode });
  fail("MUST_ACCEPT_TOS");
  fail("MUST_ACCEPT_TOS");
  fail("OTHER");
  expect(publish).toHaveBeenCalledTimes(2);
  now += PREDICTION_FAILED_NOTIFY_EVERY_MS;
  fail("MUST_ACCEPT_TOS");
  expect(publish).toHaveBeenCalledTimes(3);
});

test("miner errors notify at most once per interval, counting the rest", () => {
  const publish = vi.fn();
  const stateService = new EventEmitter();
  let now = 0;
  watchDoorbell({ notifier: { publish }, stateService, now: () => now });
  const error = (message: string | null) =>
    stateService.emit("event", { ts: now, type: "ERROR", message });
  error("Error occurred: Twitch API: timed out");
  now += 1000;
  error("held back");
  error("held back");
  now += ERROR_NOTIFY_EVERY_MS;
  error(null);
  now += ERROR_NOTIFY_EVERY_MS;
  error("alone");
  expect(publish.mock.calls.map(([n]) => [n.kind, n.body, n.link, n.tag])).toEqual([
    ["miner.error", "Error occurred: Twitch API: timed out", "/?open=logs", "miner-error"],
    ["miner.error", "The miner reported an error. (2 more since the last notice)",
      "/?open=logs", "miner-error"],
    ["miner.error", "alone", "/?open=logs", "miner-error"],
  ]);
});
