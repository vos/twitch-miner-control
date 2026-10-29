import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { ERROR_NOTIFY_EVERY_MS, watchDoorbell } from "./doorbell.js";

test("notable miner events are published with the miner's own words", () => {
  const publish = vi.fn();
  const stateService = new EventEmitter();
  watchDoorbell({ notifier: { publish }, stateService });
  stateService.emit("event", { ts: 1, type: "DROP_CLAIM", message: "Claim Drop 1 (Rust)" });
  stateService.emit("event", { ts: 2, type: "GIFT_SUB_RECEIVED", message: null });
  stateService.emit("event", { ts: 3, type: "GAIN_FOR_WATCH", message: "+10" });
  expect(publish.mock.calls.map(([n]) => [n.kind, n.title, n.body])).toEqual([
    ["drop.claimed", "Drop claimed", "Claim Drop 1 (Rust)"],
    ["gift.received", "Gift sub received", "Gift sub received"],
  ]);
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
