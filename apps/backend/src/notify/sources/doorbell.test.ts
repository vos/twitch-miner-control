import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { watchDoorbell } from "./doorbell.js";

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
