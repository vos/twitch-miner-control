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

/** A manually-controlled promise, used to hold a request open so a test
 * can deterministically arrange "another refresh arrives while the first
 * is still in flight" without relying on microtask-timing luck. */
/**
 * Flushes pending microtasks. StateService resolves its streamer roster
 * with `await` before issuing a request, so a round trip is in flight one
 * microtask after refresh() returns, not synchronously.
 */
function tick(): Promise<void> {
  return Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

// I3: `code: "AUTH"` is state.py's verdict that it reloaded the cookie
// pickle and still could not authenticate -- the session is dead, not
// merely a flaky request. The HTTP layer needs its own event to turn this
// into a visible "sign in again" prompt, distinct from ordinary refresh
// failures (a GQL hiccup must not send the user back to the login screen).
test("a refresh failure carrying code AUTH emits auth-error", async () => {
  const authError = Object.assign(new Error("session dead"), { code: "AUTH" });
  const { service } = make([authError]);
  const seen: unknown[] = [];
  service.on("auth-error", (err) => seen.push(err));
  await service.refresh();
  expect(seen).toEqual([authError]);
});

test("an ordinary refresh failure does not emit auth-error", async () => {
  const { service } = make([new Error("gql exploded")]);
  const seen: unknown[] = [];
  service.on("auth-error", (err) => seen.push(err));
  await service.refresh();
  expect(seen).toEqual([]);
});

// I5: arming the interval alone left the first tick a full period away, so
// for 60s after every restart the dashboard rendered a confident "Total
// channel points: 0" built from no data at all, beside a badge nobody was
// looking at. start() must kick a refresh immediately so the snapshot is
// either real or explicitly "never updated" -- never a fabricated zero.
test("start() kicks an immediate refresh instead of waiting for the first interval tick", async () => {
  vi.useFakeTimers();
  const { service, request } = make([alpha(100)]);
  expect(service.snapshot().lastUpdated).toBeNull();

  service.start();
  // Zero time has elapsed: if start() only armed setInterval, nothing
  // would have been requested yet.
  await vi.advanceTimersByTimeAsync(0);

  expect(request).toHaveBeenCalledTimes(1);
  expect(service.snapshot().lastUpdated).not.toBeNull();

  service.stop();
  vi.useRealTimers();
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

// Fix round 1: a refresh() (or the ring() debounce firing) arriving while
// an earlier refresh is still in flight must not be silently dropped.
// Before the fix, refresh() just returned the stale in-flight promise and
// never scheduled a follow-up -- the new event's data was never fetched
// until the next unrelated trigger (next ring() or the 60s tick), which
// silently degrades the doorbell to plain polling.

test("a refresh arriving during an in-flight refresh triggers exactly one follow-up round trip", async () => {
  const d1 = deferred<unknown>();
  const request = vi.fn()
    .mockImplementationOnce(() => d1.promise)
    .mockImplementation(async () => alpha(100));
  const service = new StateService({
    client: { request } as never,
    history,
    getStreamers: () => ["alpha"],
    staleAfterMs: 1000,
    debounceMs: 50,
    now: () => clock,
  });

  const p1 = service.refresh();
  // getStreamers is awaited (it may fetch the follow list), so the round
  // trip is dispatched a microtask after refresh() returns rather than
  // synchronously within it. Let that settle before counting requests --
  // the coalescing this test is about is unaffected, since `inFlight` is
  // still assigned synchronously inside refresh().
  await tick();
  expect(request).toHaveBeenCalledTimes(1);

  // A second arrival while the first request is still outstanding.
  service.refresh();
  await tick();
  expect(request).toHaveBeenCalledTimes(1); // coalesced, no new request yet

  d1.resolve(alpha(100));
  await p1;

  // The follow-up must have actually been dispatched, not just "no error
  // was thrown" -- assert the real second round trip happened.
  expect(request).toHaveBeenCalledTimes(2);
});

test("several arrivals during one in-flight window produce exactly one follow-up, not one per arrival", async () => {
  const d1 = deferred<unknown>();
  const request = vi.fn()
    .mockImplementationOnce(() => d1.promise)
    .mockImplementation(async () => alpha(100));
  const service = new StateService({
    client: { request } as never,
    history,
    getStreamers: () => ["alpha"],
    staleAfterMs: 1000,
    debounceMs: 50,
    now: () => clock,
  });

  const p1 = service.refresh();
  service.refresh();
  service.refresh();
  service.refresh();
  service.refresh();
  await tick(); // see the note on dispatch timing above
  expect(request).toHaveBeenCalledTimes(1);

  d1.resolve(alpha(100));
  await p1;

  // Five arrivals during the same in-flight window collapse into a
  // single follow-up -- a thundering burst must not become a burst of
  // follow-up requests.
  expect(request).toHaveBeenCalledTimes(2);
});

test("the follow-up still runs when the in-flight refresh rejects", async () => {
  const d1 = deferred<unknown>();
  const d2 = deferred<unknown>();
  const request = vi.fn()
    .mockImplementationOnce(() => d1.promise)
    .mockImplementationOnce(() => d2.promise);
  const service = new StateService({
    client: { request } as never,
    history,
    getStreamers: () => ["alpha"],
    staleAfterMs: 1000,
    debounceMs: 50,
    now: () => clock,
  });

  const p1 = service.refresh();
  service.refresh(); // arrives during the in-flight (soon-to-fail) request
  d1.reject(new Error("gql exploded"));
  await p1; // doRefresh() catches internally, so p1 resolves, not rejects

  // An error on the in-flight refresh must not strand the pending update
  // -- the follow-up still fires (the second round trip is dispatched
  // synchronously once the first settles, whether it succeeded or not).
  expect(request).toHaveBeenCalledTimes(2);

  // Let the follow-up's own request resolve, and wait deterministically
  // (via the "change" event it emits on success, rather than guessing at
  // microtask timing) for it to finish updating state.
  const secondSettled = new Promise<void>((resolve) => {
    service.once("change", () => resolve());
  });
  d2.resolve(alpha(100));
  await secondSettled;

  expect(service.snapshot().error).toBe(null);
  expect(service.snapshot().streamers[0].points).toBe(100);
});

test("stop() during an in-flight refresh clears a pending dirty flag so no follow-up fires", async () => {
  const d1 = deferred<unknown>();
  const request = vi.fn()
    .mockImplementationOnce(() => d1.promise)
    .mockImplementation(async () => alpha(100));
  const service = new StateService({
    client: { request } as never,
    history,
    getStreamers: () => ["alpha"],
    staleAfterMs: 1000,
    debounceMs: 50,
    now: () => clock,
  });

  const p1 = service.refresh();
  service.refresh(); // sets the dirty flag
  service.stop();
  d1.resolve(alpha(100));
  await p1;

  // stop() must leave nothing pending -- the dirty flag must not
  // resurrect a refresh once the in-flight request settles.
  expect(request).toHaveBeenCalledTimes(1);
});

test("reports 24h gain against the balance in force a day ago", async () => {
  clock = 90_000_000;
  history.recordPoints("alpha", 1000, clock - 86_400_000);
  const { service } = make([alpha(1500)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].gained24h).toBe(500);
});

test("reports null 24h gain when there is no prior balance to compare", async () => {
  // A fresh install must not claim a confident "+0" it cannot know.
  const { service } = make([alpha(1500)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].gained24h).toBe(null);
});

test("anchors stream gain to the moment a streamer came online", async () => {
  const { service } = make([alpha(100, false), alpha(100, true), alpha(340, true)]);
  await service.refresh();                       // offline, no anchor
  await service.refresh();                       // false -> true: anchor at 100
  await service.refresh();                       // still live, now 340
  expect(service.snapshot().streamers[0].gainedStream).toBe(240);
});

test("reports null stream gain for an offline streamer", async () => {
  const { service } = make([alpha(100, false)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].gainedStream).toBe(null);
});

test("drops the stream anchor when a streamer goes offline", async () => {
  const { service } = make([alpha(100, false), alpha(100, true), alpha(500, false)]);
  await service.refresh();
  await service.refresh();
  await service.refresh();
  expect(service.snapshot().streamers[0].gainedStream).toBe(null);
});

test("attaches a sparkline series", async () => {
  clock = 90_000_000;
  history.recordPoints("alpha", 900, clock - 3_600_000);
  const { service } = make([alpha(1000)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].spark.length).toBeGreaterThan(0);
});

test("does not emit a change frame when only wall-clock time has passed", async () => {
  // Derived fields must not encode "now", or every refresh would wake
  // every SSE client with an identical payload.
  const { service } = make([alpha(100), alpha(100)]);
  await service.refresh();
  const changes = vi.fn();
  service.on("change", changes);
  clock += 60_000;
  await service.refresh();
  expect(changes).not.toHaveBeenCalled();
});
