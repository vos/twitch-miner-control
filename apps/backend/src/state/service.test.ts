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

const alpha = (points: number, isOnline = true, stream = "S1", startedAt = 1000) => ({
  streamers: [{
    username: "alpha", channelId: "42", displayName: "Alpha",
    points, isOnline, pointsEnabled: true,
    streamId: isOnline ? stream : null,
    streamStartedAt: isOnline ? startedAt : null,
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

// A dead session is not a failed request: the dashboard has a purpose-built
// "Twitch sign-in needed" notice for it, so repeating the helper's raw GQL
// traceback in the error alert is both unreadable and redundant. Reported by
// the user after logging out of Twitch, which is exactly this state on
// demand.
test("a dead session reports no error text, because the sign-in notice covers it", async () => {
  const authError = Object.assign(
    new Error("GQL Operation 'ChannelPointsContext' failed all 3 attempts, errors: [Traceback..."),
    { code: "AUTH" },
  );
  const { service } = make([authError]);
  await service.refresh();
  expect(service.snapshot().error).toBe(null);
});

test("a dead session clears the roster instead of leaving stale cards", async () => {
  // Points read against a session that no longer exists are unverifiable,
  // and a refresh cannot correct them -- so leaving the cards up shows
  // numbers nothing will ever update, beside a notice saying we are signed
  // out. The user saw exactly this: cards that survived a page reload.
  const { service } = make([
    alpha(100),
    Object.assign(new Error("401 Client Error: Unauthorized"), { code: "AUTH" }),
  ]);
  await service.refresh();
  expect(service.snapshot().streamers).toHaveLength(1);
  await service.refresh();
  expect(service.snapshot().streamers).toEqual([]);
});

test("a dead session still marks the snapshot stale", async () => {
  // Clearing the error must not make a signed-out dashboard look healthy.
  const authError = Object.assign(new Error("401"), { code: "AUTH" });
  const { service } = make([authError]);
  await service.refresh();
  expect(service.snapshot().stale).toBe(true);
});

test("an ordinary refresh failure keeps its error text and the last numbers", async () => {
  // The contrast case: a GQL hiccup is transient, the next refresh may well
  // succeed, and the numbers on screen are still the best known -- so this
  // path must keep reporting both.
  const { service } = make([alpha(100), new Error("gql exploded")]);
  await service.refresh();
  await service.refresh();
  expect(service.snapshot().error).toBe("gql exploded");
  expect(service.snapshot().streamers).toHaveLength(1);
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
  expect(service.snapshot().streamers[0].gainedSince).toBe(null);
});

test("falls back to the earliest balance when history is younger than 24h", async () => {
  // Three hours of history is a real number over a real window. Hiding it
  // until the 24h mark withheld a gain the backend already knew.
  clock = 90_000_000;
  history.recordPoints("alpha", 1000, clock - 3 * 3_600_000);
  const { service } = make([alpha(1200)]);
  await service.refresh();
  const s = service.snapshot().streamers[0];
  expect(s.gained24h).toBe(200);
  // The window actually covered, so the UI can label it "3h" not "24h".
  expect(s.gainedSince).toBe(clock - 3 * 3_600_000);
});

test("reports the full window when history reaches back past 24h", async () => {
  clock = 90_000_000;
  history.recordPoints("alpha", 800, clock - 40 * 3_600_000);
  history.recordPoints("alpha", 1000, clock - 86_400_000);
  const { service } = make([alpha(1500)]);
  await service.refresh();
  const s = service.snapshot().streamers[0];
  expect(s.gained24h).toBe(500);
  // A full window reports no span: the label is simply "24h". Reporting
  // the cutoff would encode "now" and make every tick a fresh SSE frame.
  expect(s.gainedSince).toBe(null);
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
  //
  // Subscribed from the *second* refresh on: the first tick is the only
  // sample there is, so gained24h is null; the second gives it an earlier
  // balance to measure against and it becomes 0. That single transition is
  // a real change in what we know, and is what the partial-window
  // fallback exists to report. From there the payload must go quiet.
  const { service } = make([alpha(100), alpha(100), alpha(100)]);
  await service.refresh();
  clock += 60_000;
  await service.refresh();
  const changes = vi.fn();
  service.on("change", changes);
  clock += 60_000;
  await service.refresh();
  expect(changes).not.toHaveBeenCalled();
});

test("attaches the resolved avatar url to each streamer", async () => {
  const { service } = make([alpha(100)]);
  (service as never as { deps: { avatars: unknown } }).deps.avatars = {
    resolve: async () => new Map([["alpha", "https://cdn/a.png"]]),
  };
  await service.refresh();
  expect(service.snapshot().streamers[0].avatarUrl).toBe("https://cdn/a.png");
});

test("avatarUrl is null when no avatar cache is wired in", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].avatarUrl).toBe(null);
});

test("a rejecting avatar cache leaves the balances intact and the state clean", async () => {
  // The dashboard's actual job is the numbers. An avatar lookup that
  // blows up must not mark the snapshot stale or blank the roster.
  const { service } = make([alpha(100)]);
  (service as never as { deps: { avatars: unknown } }).deps.avatars = {
    resolve: async () => { throw new Error("cache exploded"); },
  };
  await service.refresh();
  const snapshot = service.snapshot();
  expect(snapshot.streamers[0].points).toBe(100);
  expect(snapshot.streamers[0].avatarUrl).toBe(null);
  expect(snapshot.error).toBe(null);
  expect(snapshot.stale).toBe(false);
});

test("a stable avatar url does not emit a change frame on every tick", async () => {
  // avatarUrl joins the JSON.stringify change comparison, so a value that
  // varied per tick would wake every SSE client once a minute forever.
  const { service } = make([alpha(100), alpha(100)]);
  (service as never as { deps: { avatars: unknown } }).deps.avatars = {
    resolve: async () => new Map([["alpha", "https://cdn/a.png"]]),
  };
  const changes = vi.fn();
  await service.refresh();
  service.on("change", changes);
  await service.refresh();
  expect(changes).not.toHaveBeenCalled();
});

test("attributes a doorbell event to a roster streamer", async () => {
  const { service } = make([alpha(100)], ["alpha"]);
  await service.refresh();
  service.ring("GAIN_FOR_CLAIM", "+50 -> alpha");
  expect(history.lastActivity("alpha")).toEqual({ ts: clock, type: "GAIN_FOR_CLAIM" });
});

test("leaves an unattributable event off every card", async () => {
  const { service } = make([alpha(100)], ["alpha"]);
  await service.refresh();
  service.ring("GAIN_FOR_CLAIM", "+50 -> someone_else");
  expect(history.lastActivity("alpha")).toBeNull();
  // Still recorded for the feed, which shows every event.
  expect(history.recentEvents(10)).toHaveLength(1);
});

test("marks a streamer watched after a watch gain lands", async () => {
  // The miner never publishes which channels hold its two watch slots, so
  // a GAIN_FOR_WATCH is the only evidence this side gets.
  const { service } = make([alpha(100), alpha(100)], ["alpha"]);
  await service.refresh();
  expect(service.snapshot().streamers[0].watching).toBe(false);

  service.ring("GAIN_FOR_WATCH", "+10 -> alpha");
  await service.refresh();
  expect(service.snapshot().streamers[0].watching).toBe(true);
});

test("stops calling a streamer watched once the gain goes stale", async () => {
  const { service } = make([alpha(100), alpha(100)], ["alpha"]);
  await service.refresh();
  service.ring("GAIN_FOR_WATCH", "+10 -> alpha");

  // Past the ten-minute window: the miner has moved the slot elsewhere and
  // the badge must not keep claiming this channel is being mined.
  clock += 11 * 60_000;
  await service.refresh();
  expect(service.snapshot().streamers[0].watching).toBe(false);
});

test("an offline streamer is never watched, however recent the gain", async () => {
  // Guards a channel that drops inside the window: the stream ended, so
  // the gain it produced says nothing about now.
  const { service } = make([alpha(100), alpha(100, false)], ["alpha"]);
  await service.refresh();
  service.ring("GAIN_FOR_WATCH", "+10 -> alpha");
  await service.refresh();
  expect(service.snapshot().streamers[0].watching).toBe(false);
});

test("a claim alone does not mark a streamer watched", async () => {
  // Points can arrive from a claim on a channel the miner is not watching.
  const { service } = make([alpha(100), alpha(100)], ["alpha"]);
  await service.refresh();
  service.ring("GAIN_FOR_CLAIM", "+50 -> alpha");
  await service.refresh();
  expect(service.snapshot().streamers[0].watching).toBe(false);
});

test("reports the stream start from Twitch, not from when we looked", async () => {
  clock = 3_600_000;
  const { service } = make([alpha(100, true, "S1", 1000)]);
  await service.refresh();
  // Twitch says the stream began at 1000; we first looked an hour in.
  expect(service.snapshot().streamers[0].liveSince).toBe(1000);
});

test("keeps the stream gain across a restart", async () => {
  // Two services sharing only the database, as a restart would. The old
  // in-memory anchor map lost this and silently reset the gain to zero.
  const first = make([alpha(100)]).service;
  await first.refresh();
  const second = make([alpha(150)]).service;
  await second.refresh();
  expect(second.snapshot().streamers[0].gainedStream).toBe(50);
});

test("reports a stream gain for a streamer added mid-stream", async () => {
  // No false->true transition was ever observed, so the old map had no
  // anchor and reported null forever.
  const { service } = make([alpha(100), alpha(180)]);
  await service.refresh();
  clock += 60_000;
  await service.refresh();
  expect(service.snapshot().streamers[0].gainedStream).toBe(80);
});

test("resets the stream gain when a new stream starts", async () => {
  const { service } = make([alpha(100, true, "S1"), alpha(180, true, "S2", 500_000)]);
  await service.refresh();
  clock += 60_000;
  await service.refresh();
  // A new stream id is a new anchor, not a continuation of the old one.
  expect(service.snapshot().streamers[0].gainedStream).toBe(0);
});

test("reports no stream gain when offline", async () => {
  const { service } = make([alpha(100, false)]);
  await service.refresh();
  expect(service.snapshot().streamers[0].gainedStream).toBeNull();
  expect(service.snapshot().streamers[0].liveSince).toBeNull();
});

test("suppresses points per hour below the mining floor", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  // A single tick of mining time is far under 15 minutes; a rate here
  // would be a confident four-digit number contradicted next tick.
  expect(service.snapshot().streamers[0].pointsPerHour).toBeNull();
});

test("quantises durations to whole minutes", async () => {
  clock = 10_000_000;
  const { service } = make([alpha(100)]);
  await service.refresh();
  const s = service.snapshot().streamers[0];
  for (const value of [s.online24h, s.mined24h, s.minedTotal]) {
    // Unrounded values change every tick by definition -- an open span
    // always grows -- and would make every SSE frame a broadcast.
    expect(value % 60_000).toBe(0);
  }
});

test("counts no mining time when the miner never ran", async () => {
  // A closed stream, so there is history to measure. The live stream's
  // own duration is deliberately excluded -- see the next test.
  clock = 10_000_000;
  history.openStreamerSession("alpha", "S0", clock - 7_200_000, 0);
  history.recordPoints("alpha", 1, clock - 3_600_000);
  history.closeStreamerSessionsExcept("alpha", null, clock - 3_600_000);
  const { service } = make([alpha(100, true, "S1", clock - 60_000)]);
  await service.refresh();
  const s = service.snapshot().streamers[0];
  // Online but unmined: the whole point of two clocks.
  expect(s.online24h).toBe(3_600_000);
  expect(s.mined24h).toBe(0);
});

test("counts only the miner's own uptime inside a much longer stream", () => {
  // The bug from the dashboard: a miner started minutes into a day-long
  // stream must report minutes, not the stream's whole length.
  clock = 10_000_000;
  history.openStreamerSession("alpha", "S1", clock - 26 * 3_600_000, 0);
  history.openMinerSession(clock - 13 * 60_000);
  const { service } = make([alpha(100, true, "S1", clock - 26 * 3_600_000)]);
  return service.refresh().then(() => {
    const s = service.snapshot().streamers[0];
    expect(s.mined24h).toBe(10 * 60_000);   // 13 min, quantised down to 10
    expect(s.online24h).toBe(86_400_000);   // the window's full width
  });
});

test("counts mining time only while the miner was up", async () => {
  // A two-hour closed stream with the miner up for only the last hour of
  // it: the gap between the clocks is the figure that matters.
  clock = 10_000_000;
  const streamStart = clock - 7_200_000;
  const streamEnd = clock - 3_600_000;
  history.openStreamerSession("alpha", "S0", streamStart, 0);
  history.recordPoints("alpha", 1, streamEnd);
  history.closeStreamerSessionsExcept("alpha", null, streamEnd);
  history.openMinerSession(streamStart + 1_800_000);
  history.closeMinerSession(streamEnd);
  const { service } = make([alpha(100, true, "S1", clock - 60_000)]);
  await service.refresh();
  const s = service.snapshot().streamers[0];
  // The closed stream's hour, plus the minute the live one has run.
  expect(s.online24h).toBe(3_600_000);
  expect(s.mined24h).toBe(1_800_000);
});

test("quantises live figures so a poll rarely changes the payload", async () => {
  // These grow with the wall clock while a stream runs, so they are
  // rounded down to a coarse step rather than cut off -- cutting them
  // off is what under-reported mining time to zero. One poll's worth of
  // elapsed time must not move them.
  clock = 10_000_000;
  const { service } = make([alpha(100), alpha(100)]);
  await service.refresh();
  const first = service.snapshot().streamers[0].online24h;
  clock += 60_000;
  await service.refresh();
  expect(service.snapshot().streamers[0].online24h).toBe(first);
});

test("beats the miner heartbeat on every refresh", async () => {
  const { service } = make([alpha(100)]);
  history.openMinerSession(500);
  await service.refresh();
  history.recoverOpenSessions();
  // The heartbeat advanced to the refresh, so recovery closes there
  // rather than back at the session's start.
  expect(history.minerSpans()).toEqual([{ start: 500, end: clock }]);
});

test("emits the recorded row so the stream can push it to clients", async () => {
  const { service } = make([alpha(100)], ["alpha"]);
  await service.refresh();
  const events = vi.fn();
  service.on("event", events);
  service.ring("GAIN_FOR_CLAIM", "+50 -> alpha");
  // The same shape /api/events serves, so a client can append a pushed row
  // to the list it fetched on mount without reconciling two formats.
  expect(events).toHaveBeenCalledWith({
    ts: clock, type: "GAIN_FOR_CLAIM", message: "+50 -> alpha",
  });
});

test("emits an event per ring, even while the refresh debounce coalesces", async () => {
  const { service } = make([alpha(100)], ["alpha"]);
  await service.refresh();
  const events = vi.fn();
  service.on("event", events);
  // Bursts coalesce into one refresh -- but every event is a distinct feed
  // row, so none may be dropped along the way.
  service.ring("GAIN_FOR_CLAIM", "+50 -> alpha");
  service.ring("GAIN_FOR_CLAIM", "+60 -> alpha");
  expect(events).toHaveBeenCalledTimes(2);
});

test("a dead session is stale even right after a successful refresh", async () => {
  // Guards the interaction between the two: clearing lastError removes one
  // of the two things snapshot() derives staleness from, so a session that
  // dies seconds after a good refresh must not read as fresh on the age
  // check alone.
  const { service } = make([
    alpha(100),
    Object.assign(new Error("401"), { code: "AUTH" }),
  ]);
  await service.refresh();
  expect(service.snapshot().stale).toBe(false);
  await service.refresh();
  expect(service.snapshot().stale).toBe(true);
});

test("signing back in clears the dead-session state", async () => {
  // The recovery path: without this the dashboard would stay stale forever
  // after a successful re-login, since nothing else resets the flag.
  const { service } = make([
    Object.assign(new Error("401"), { code: "AUTH" }),
    alpha(100),
  ]);
  await service.refresh();
  expect(service.snapshot().stale).toBe(true);
  await service.refresh();
  expect(service.snapshot().stale).toBe(false);
  expect(service.snapshot().streamers).toHaveLength(1);
});

test("a fresh login drops an error left over from the signed-out session", async () => {
  // The race the user hit: a refresh was already in flight against the old
  // session when the login completed, so its 401 landed *after*
  // markLoggedIn(). state.py classifies that one as GQL rather than AUTH --
  // by the time it re-checks, the new pickle is on disk and the session
  // reads as healthy -- so the AUTH suppression does not apply and the raw
  // traceback reached the dashboard, clearing only when the next refresh
  // happened to succeed seconds later.
  const { service } = make([new Error("GQL Operation 'ChannelPointsContext' failed...")]);
  await service.refresh();
  expect(service.snapshot().error).not.toBeNull();

  service.clearError();

  expect(service.snapshot().error).toBeNull();
});

test("clearing the error announces the change to connected clients", async () => {
  // The dashboard renders from pushed snapshots; without a frame the stale
  // traceback would sit on screen until some unrelated refresh redrew it.
  const { service } = make([new Error("boom")]);
  await service.refresh();
  const seen: unknown[] = [];
  service.on("change", (s) => seen.push(s));
  service.clearError();
  expect(seen).toHaveLength(1);
});

test("clearing the error on a healthy service changes nothing", async () => {
  const { service } = make([alpha(100)]);
  await service.refresh();
  const seen: unknown[] = [];
  service.on("change", (s) => seen.push(s));
  service.clearError();
  expect(seen).toEqual([]);
  expect(service.snapshot().streamers).toHaveLength(1);
});

test("a 401 answered by the old helper cannot re-post itself after a login", async () => {
  // The remaining half of the race: clearError() runs at login, but the
  // in-flight request it was meant to discard may not have rejected yet.
  // When it does, doRefresh's catch must not write the traceback back.
  let rejectInFlight!: (e: Error) => void;
  const request = vi.fn(() => new Promise((_, reject) => { rejectInFlight = reject; }));
  const service = new StateService({
    client: { request } as never,
    history,
    getStreamers: () => ["alpha"],
    staleAfterMs: 1000,
    now: () => clock,
  });

  const inFlight = service.refresh();
  await Promise.resolve();
  // The login lands while that request is still open.
  service.clearError();
  // Only now does the old helper's 401 come back.
  rejectInFlight(new Error("401 Client Error: Unauthorized for url: https://gql.twitch.tv/gql"));
  await inFlight;

  expect(service.snapshot().error).toBeNull();
});
