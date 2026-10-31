import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";
import { History } from "../db/history.js";
import { openDb } from "../db/schema.js";
import { CLAIM_VERIFY_DELAY_MS, syncClaims, verifyClaimAttempts } from "./dropClaims.js";

const claim = (id: string) => ({ id, name: `Reward ${id}`, campaignId: "c1", earnedAt: 1 });

let history: History;
beforeEach(() => {
  history = new History(openDb(":memory:"));
});

test("the first sync records the backlog silently", () => {
  // Twitch answers with every reward ever earned, none of them news.
  const publish = vi.fn();
  syncClaims({ history, notifier: { publish } }, [claim("a"), claim("b")]);
  expect(publish).not.toHaveBeenCalled();
  expect(history.countClaims(0, 10)).toBe(2);
});

test("a claim new since the last sync is announced by its reward", () => {
  const publish = vi.fn();
  syncClaims({ history, notifier: { publish } }, [claim("a")]);
  syncClaims({ history, notifier: { publish } }, [claim("a"), claim("b")]);
  expect(publish.mock.calls.map(([n]) => [n.kind, n.title, n.body, n.link])).toEqual([
    ["drop.claimed", "Drop claimed", "Reward b", "/?open=drops"],
  ]);
});

test("the same claim is never announced twice", () => {
  const publish = vi.fn();
  syncClaims({ history, notifier: { publish } }, [claim("a")]);
  syncClaims({ history, notifier: { publish } }, [claim("a"), claim("b")]);
  syncClaims({ history, notifier: { publish } }, [claim("a"), claim("b")]);
  expect(publish).toHaveBeenCalledOnce();
});

test("a claim attempt rereads the inventory once the claim has had time to land", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {});
  const stateService = new EventEmitter();
  verifyClaimAttempts({ stateService, inventory: { refresh } });
  stateService.emit("event", { type: "DROP_CLAIM" });
  await vi.advanceTimersByTimeAsync(CLAIM_VERIFY_DELAY_MS - 1);
  expect(refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(refresh).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

test("a burst of attempts rereads the inventory once", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {});
  const stateService = new EventEmitter();
  verifyClaimAttempts({ stateService, inventory: { refresh } });
  stateService.emit("event", { type: "DROP_CLAIM" });
  stateService.emit("event", { type: "DROP_CLAIM" });
  await vi.advanceTimersByTimeAsync(CLAIM_VERIFY_DELAY_MS);
  expect(refresh).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

test("other events leave the inventory alone", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => {});
  const stateService = new EventEmitter();
  verifyClaimAttempts({ stateService, inventory: { refresh } });
  stateService.emit("event", { type: "GAIN_FOR_WATCH" });
  await vi.advanceTimersByTimeAsync(CLAIM_VERIFY_DELAY_MS);
  expect(refresh).not.toHaveBeenCalled();
  vi.useRealTimers();
});
