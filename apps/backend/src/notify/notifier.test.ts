import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { memoryLog } from "../appLog/memory.js";
import { openDb } from "../db/schema.js";
import { NOTIFY_KIND, type Notification } from "./catalogue.js";
import { Notifier, type Channel } from "./notifier.js";
import { NotifyStore, type Destination } from "./store.js";

let store: NotifyStore;
let sent: Array<{ id: string; n: Notification }>;
let channel: Channel & { send: ReturnType<typeof vi.fn> };
let log: ReturnType<typeof memoryLog>;
let notifier: Notifier;
const NOON = Date.UTC(2026, 8, 23, 10);

beforeEach(() => {
  vi.useFakeTimers();
  store = new NotifyStore(openDb(":memory:"));
  sent = [];
  channel = {
    send: vi.fn(async (d: Destination, n: Notification) => {
      sent.push({ id: d.id, n });
      return { ok: true as const };
    }),
  };
  log = memoryLog();
  notifier = new Notifier({ store, channels: { webpush: channel }, now: () => NOON, log });
});
afterEach(() => { notifier.stop(); vi.useRealTimers(); });

// Each device gets a distinct `now`, so `NotifyStore.list()` (ordered by
// created_ts, then id) sorts them in creation order rather than falling
// back to a tie-break on a random UUID.
let deviceCounter = 0;
const device = (endpoint: string) => store.upsertWebPush({
  subscription: { endpoint, keys: { p256dh: "p", auth: "a" } },
  label: endpoint, timeZone: "Europe/Berlin", now: ++deviceCounter,
}).destination;

const crash = { kind: NOTIFY_KIND.MINER_CRASHED, title: "Miner crashed", body: "b", link: "/?open=logs" };

test("an inbox kind is stored and announced, a high-volume kind is not", () => {
  const rows: unknown[] = [];
  notifier.onInbox((row) => rows.push(row));
  notifier.publish(crash);
  notifier.publish({ kind: NOTIFY_KIND.RAID_JOINED, title: "Raid", body: "b", link: "/" });
  expect(store.inbox(null, 10).map((r) => r.kind)).toEqual(["miner.crashed"]);
  expect(rows).toHaveLength(1);
});

test("the inbox records even with no destinations at all", () => {
  notifier.publish(crash);
  expect(store.inbox(null, 10)).toHaveLength(1);
  expect(channel.send).not.toHaveBeenCalled();
});

test("delivery goes only to enabled destinations that want the kind", async () => {
  const a = device("https://push.example/a");
  const b = device("https://push.example/b");
  const c = device("https://push.example/c");
  store.update(b.id, { enabled: false });
  store.update(c.id, { prefs: { ...c.prefs, kinds: { "miner.crashed": false } } });
  notifier.publish(crash);
  await vi.runAllTimersAsync();
  expect(sent.map((s) => s.id)).toEqual([a.id]);
  expect(sent[0].n.ts).toBe(NOON);
});

test("a repeated dedupe key is dropped entirely", async () => {
  device("https://push.example/a");
  notifier.publish({ ...crash, dedupeKey: "k" });
  notifier.publish({ ...crash, dedupeKey: "k" });
  await vi.runAllTimersAsync();
  expect(sent).toHaveLength(1);
  expect(store.inbox(null, 10)).toHaveLength(1);
});

test("a dedupe key survives a new notifier on the same store", async () => {
  device("https://push.example/a");
  notifier.publish({ ...crash, dedupeKey: "k" });
  const again = new Notifier({ store, channels: { webpush: channel }, now: () => NOON });
  again.publish({ ...crash, dedupeKey: "k" });
  await vi.runAllTimersAsync();
  expect(sent).toHaveLength(1);
});

test("batchable kinds wait for the window and arrive as one", async () => {
  const a = device("https://push.example/a");
  store.update(a.id, { prefs: { ...a.prefs, kinds: { "streamer.online": true } } });
  for (const login of ["alpha", "beta"]) {
    notifier.publish({
      kind: NOTIFY_KIND.STREAMER_ONLINE, title: `${login} is live`, body: "Went live",
      streamer: { login, name: login }, link: "/",
    });
  }
  expect(sent).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sent).toHaveLength(1);
  expect(sent[0].n.title).toBe("2 streamers went live");
});

test("a follow-up reaches exactly the destinations that got the tagged one", async () => {
  const a = device("https://push.example/a");
  device("https://push.example/b");
  const b = store.list()[1];
  store.update(b.id, { prefs: { ...b.prefs, kinds: { "restart.pending": false } } });
  notifier.publish({ kind: NOTIFY_KIND.RESTART_PENDING, title: "p", body: "b", link: "/", tag: "restart" });
  // a now opts out and b opts in; neither changes who gets the follow-up.
  store.update(a.id, { prefs: { ...a.prefs, kinds: { "restart.pending": false } } });
  store.update(b.id, { prefs: { ...b.prefs, kinds: { "restart.pending": true } } });
  notifier.publish({ kind: NOTIFY_KIND.RESTART_PENDING, title: "c", body: "b", link: "/", tag: "restart", followUp: true });
  await vi.runAllTimersAsync();
  expect(sent.map((s) => [s.n.title, s.id])).toEqual([["p", a.id], ["c", a.id]]);
});

test("a gone subscription deletes its destination", async () => {
  const a = device("https://push.example/a");
  channel.send.mockResolvedValueOnce({ ok: false, gone: true, error: "push service answered 410" });
  notifier.publish(crash);
  await vi.runAllTimersAsync();
  expect(store.get(a.id)).toBeNull();
  expect(log.ofType("notify.device.expired")).toHaveLength(1);
});

test("a failure is recorded on the destination and logged", async () => {
  const a = device("https://push.example/a");
  channel.send.mockResolvedValueOnce({ ok: false, gone: false, error: "push service answered 500" });
  notifier.publish(crash);
  await vi.runAllTimersAsync();
  expect(store.get(a.id)?.lastError).toBe("push service answered 500");
  expect(log.ofType("notify.failed")).toHaveLength(1);
});

test("one failing destination does not stop the others", async () => {
  device("https://push.example/a");
  const b = device("https://push.example/b");
  channel.send.mockRejectedValueOnce(new Error("boom"));
  notifier.publish(crash);
  await vi.runAllTimersAsync();
  expect(sent.map((s) => s.id)).toEqual([b.id]);
});

test("publish never throws", () => {
  const broken = new Notifier({
    store: { markSeen: () => { throw new Error("disk full"); } } as never,
    channels: {}, log,
  });
  expect(() => broken.publish({ ...crash, dedupeKey: "k" })).not.toThrow();
  expect(log.ofType("notify.failed")).toHaveLength(1);
});

test("wantsAny answers whether anyone would take a kind now", () => {
  expect(notifier.wantsAny(NOTIFY_KIND.RESTART_PENDING)).toBe(false);
  const a = device("https://push.example/a");
  expect(notifier.wantsAny(NOTIFY_KIND.RESTART_PENDING)).toBe(true);
  store.update(a.id, { enabled: false });
  expect(notifier.wantsAny(NOTIFY_KIND.RESTART_PENDING)).toBe(false);
});
