import { beforeEach, expect, test } from "vitest";
import { openDb } from "../db/schema.js";
import { NOTIFY_KIND } from "./catalogue.js";
import { INBOX_RETENTION_MS, NotifyStore, SEEN_RETENTION_MS } from "./store.js";

let store: NotifyStore;
beforeEach(() => { store = new NotifyStore(openDb(":memory:")); });

const sub = (endpoint = "https://push.example/abc") => ({
  endpoint, expirationTime: null, keys: { p256dh: "p256", auth: "auth" },
});

test("a new subscription becomes an enabled destination with default prefs", () => {
  const { destination, created } = store.upsertWebPush({
    subscription: sub(), label: "Chrome on Android", timeZone: "Europe/Berlin", now: 5,
  });
  expect(created).toBe(true);
  expect(destination).toMatchObject({
    channel: "webpush", label: "Chrome on Android", endpoint: "https://push.example/abc",
    enabled: true, createdTs: 5, lastOkTs: null,
  });
  expect(destination.prefs.timeZone).toBe("Europe/Berlin");
  expect(store.list()).toHaveLength(1);
});

test("the same endpoint again updates in place and keeps prefs", () => {
  const first = store.upsertWebPush({ subscription: sub(), label: "A", timeZone: "UTC", now: 1 });
  store.update(first.destination.id, { prefs: { ...first.destination.prefs, digestAt: "07:30" } });
  const again = store.upsertWebPush({ subscription: sub(), label: "B", timeZone: "UTC", now: 2 });
  expect(again.created).toBe(false);
  expect(again.destination.id).toBe(first.destination.id);
  expect(again.destination.label).toBe("A");
  expect(again.destination.prefs.digestAt).toBe("07:30");
});

test("a previous endpoint moves its row to the new one", () => {
  const first = store.upsertWebPush({ subscription: sub("https://push.example/old"), label: "A", timeZone: "UTC", now: 1 });
  const moved = store.upsertWebPush({
    subscription: sub("https://push.example/new"), label: "A", timeZone: "UTC",
    previousEndpoint: "https://push.example/old", now: 2,
  });
  expect(moved.created).toBe(false);
  expect(moved.destination.id).toBe(first.destination.id);
  expect(moved.destination.endpoint).toBe("https://push.example/new");
  expect(store.byEndpoint("https://push.example/old")).toBeNull();
});

test("update changes only what it is given", () => {
  const { destination } = store.upsertWebPush({ subscription: sub(), label: "A", timeZone: "UTC", now: 1 });
  const paused = store.update(destination.id, { enabled: false });
  expect(paused).toMatchObject({ enabled: false, label: "A" });
  expect(store.update("missing", { enabled: false })).toBeNull();
});

test("delivery outcomes are recorded", () => {
  const { destination } = store.upsertWebPush({ subscription: sub(), label: "A", timeZone: "UTC", now: 1 });
  store.recordError(destination.id, "push service answered 500", 10);
  expect(store.get(destination.id)).toMatchObject({ lastError: "push service answered 500", lastErrorTs: 10 });
  store.recordOk(destination.id, 20);
  expect(store.get(destination.id)).toMatchObject({ lastOkTs: 20, lastError: null, lastErrorTs: null });
});

test("remove says whether anything went", () => {
  const { destination } = store.upsertWebPush({ subscription: sub(), label: "A", timeZone: "UTC", now: 1 });
  expect(store.remove(destination.id)).toBe(true);
  expect(store.remove(destination.id)).toBe(false);
});

test("the inbox pages newest first", () => {
  for (let i = 1; i <= 5; i++) {
    store.addInbox({ ts: i, kind: NOTIFY_KIND.DROP_CLAIMED, title: `t${i}`, body: "b", streamer: null, link: "/" });
  }
  const first = store.inbox(null, 2);
  expect(first.map((r) => r.title)).toEqual(["t5", "t4"]);
  expect(store.inbox(first[1].id, 10).map((r) => r.title)).toEqual(["t3", "t2", "t1"]);
});

test("a dedupe key is seen once", () => {
  expect(store.markSeen("app.update:1.6.0", 1)).toBe(true);
  expect(store.markSeen("app.update:1.6.0", 2)).toBe(false);
});

test("prune drops old inbox rows and old dedupe keys", () => {
  const now = 1_000 * 86_400_000;
  store.addInbox({ ts: now - INBOX_RETENTION_MS - 1, kind: NOTIFY_KIND.DROP_CLAIMED, title: "old", body: "", streamer: null, link: "/" });
  store.addInbox({ ts: now, kind: NOTIFY_KIND.DROP_CLAIMED, title: "new", body: "", streamer: null, link: "/" });
  store.markSeen("old", now - SEEN_RETENTION_MS - 1);
  expect(store.prune(now)).toBe(1);
  expect(store.inbox(null, 10).map((r) => r.title)).toEqual(["new"]);
  expect(store.markSeen("old", now)).toBe(true);
});
