import { beforeEach, expect, test, vi } from "vitest";
import { History } from "../db/history.js";
import { openDb } from "../db/schema.js";
import { StateService } from "./service.js";

let history: History;
let clock: number;
beforeEach(() => {
  history = new History(openDb(":memory:"));
  clock = 10_000;
});

function make(responses: unknown[], streamers = ["alpha"]) {
  const queue = [...responses];
  const request = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const service = new StateService({
    client: { request } as never,
    history,
    getStreamers: () => streamers,
    staleAfterMs: 1000,
    debounceMs: 50,
    now: () => clock,
  });
  return { service, request };
}

const alpha = (points: number, isOnline = true) => ({
  streamers: [{
    username: "alpha", channelId: "42", displayName: "Alpha",
    points, isOnline, pointsEnabled: true,
  }],
});

test("refresh publishes streamer state with a timestamp", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  const snap = service.snapshot();
  expect(snap.streamers[0].points).toBe(100);
  expect(snap.lastUpdated).toBe(10_000);
  expect(snap.stale).toBe(false);
});

test("refresh writes a point snapshot to history", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  expect(history.latest("alpha")).toBe(100);
});

test("emits change only when something actually changed", async () => {
  const { service } = make([alpha(100), alpha(100), alpha(150)]);
  const changes: number[] = [];
  service.on("change", () => changes.push(1));
  await service.refresh();
  await service.refresh();
  await service.refresh();
  expect(changes.length).toBe(2);
});

test("state goes stale once the refresh is older than staleAfterMs", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  expect(service.snapshot().stale).toBe(false);
  clock += 5000;
  expect(service.snapshot().stale).toBe(true);
});

test("a failed refresh keeps the last good numbers but marks them stale", async () => {
  const { service } = make([alpha(100), new Error("gql exploded")]);
  await service.refresh();
  clock += 1;
  await service.refresh();
  const snap = service.snapshot();
  expect(snap.streamers[0].points).toBe(100);
  expect(snap.stale).toBe(true);
  expect(snap.error).toContain("gql exploded");
});

test("a successful refresh clears a previous error", async () => {
  const { service } = make([new Error("boom"), alpha(100)]);
  await service.refresh();
  await service.refresh();
  expect(service.snapshot().error).toBe(null);
});

test("ring coalesces a burst into a single refresh", async () => {
  vi.useFakeTimers();
  const { service, request } = make([alpha(100), alpha(100), alpha(100)]);
  for (let i = 0; i < 5; i++) service.ring("GAIN_FOR_RAID");
  await vi.advanceTimersByTimeAsync(200);
  expect(request).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test("ring records the event type in history", () => {
  const { service } = make([alpha(100)]);
  service.ring("STREAMER_ONLINE");
  expect(history.recentEvents(1)[0].type).toBe("STREAMER_ONLINE");
});

test("requests exactly the configured streamers", async () => {
  const { service, request } = make([{ streamers: [] }], ["a", "b"]);
  await service.refresh();
  expect(request).toHaveBeenCalledWith("state", { streamers: ["a", "b"] });
});

test("skips the round trip when no streamers are configured", async () => {
  const { service, request } = make([], []);
  await service.refresh();
  expect(request).not.toHaveBeenCalled();
});

// Correction 1: an empty streamer list is a fully up-to-date state, not a
// stale leftover. Removing the last configured streamer must still update
// lastUpdated (fresh, not stale), clear any previous error, and notify
// listeners exactly once -- not on every subsequent empty refresh.
test("removing the last streamer clears state, is not stale, and emits change once", async () => {
  let streamers = ["alpha"];
  const queue: unknown[] = [alpha(100)];
  const request = vi.fn(async () => queue.shift());
  const service = new StateService({
    client: { request } as never,
    history,
    getStreamers: () => streamers,
    staleAfterMs: 1000,
    debounceMs: 50,
    now: () => clock,
  });

  const changes: number[] = [];
  service.on("change", () => changes.push(1));

  await service.refresh();
  expect(changes.length).toBe(1);

  streamers = [];
  clock += 1;
  await service.refresh();

  const snap = service.snapshot();
  expect(snap.streamers).toEqual([]);
  expect(snap.stale).toBe(false);
  expect(snap.lastUpdated).toBe(clock);
  expect(changes.length).toBe(2);

  // A second empty refresh must not emit again -- nothing changed.
  clock += 1;
  await service.refresh();
  expect(changes.length).toBe(2);
});
