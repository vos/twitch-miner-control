import Fastify from "fastify";
import { beforeEach, expect, test, vi } from "vitest";
import { memoryLog } from "../appLog/memory.js";
import { openDb } from "../db/schema.js";
import { NOTIFY_KIND } from "./catalogue.js";
import { registerNotifyRoutes } from "./routes.js";
import { NotifyStore } from "./store.js";

let store: NotifyStore;
let sendTo: ReturnType<typeof vi.fn>;
let redeem: ReturnType<typeof vi.fn<(token: string) => boolean>>;
let log: ReturnType<typeof memoryLog>;

async function app() {
  const instance = Fastify();
  registerNotifyRoutes(instance, {
    store,
    notifier: { sendTo, onInbox: () => {} } as never,
    vapidPublicKey: "BPublicKey",
    redeemAction: redeem,
    now: () => 42,
    log,
  });
  await instance.ready();
  return instance;
}

beforeEach(() => {
  store = new NotifyStore(openDb(":memory:"));
  sendTo = vi.fn(async () => ({ ok: true }));
  redeem = vi.fn<(token: string) => boolean>(() => false);
  log = memoryLog();
});

const subscription = {
  endpoint: "https://push.example/abc", expirationTime: null,
  keys: { p256dh: "p256", auth: "auth" },
};

const register = async (a: Awaited<ReturnType<typeof app>>, body: object = {}) => a.inject({
  method: "POST", url: "/api/notify/destinations",
  payload: { subscription, label: "Chrome on Android", timeZone: "Europe/Berlin", ...body },
});

test("config carries the key and the listed catalogue, never the test kind", async () => {
  const res = await (await app()).inject({ url: "/api/notify/config" });
  const body = res.json();
  expect(body.vapidPublicKey).toBe("BPublicKey");
  expect(body.groups[0]).toEqual({ id: "health", label: "Miner health" });
  expect(body.catalogue.some((k: { kind: string }) => k.kind === "test")).toBe(false);
  expect(body.catalogue[0]).toEqual({
    kind: "miner.crashed", group: "health", label: "Miner crashed",
    description: expect.any(String), defaultOn: true,
  });
});

test("registering creates a destination without echoing its keys", async () => {
  const a = await app();
  const res = await register(a);
  expect(res.statusCode).toBe(200);
  expect(res.json().destination).toMatchObject({ label: "Chrome on Android", enabled: true, createdTs: 42 });
  expect(res.json().destination.subscription).toBeUndefined();
  expect(log.ofType("notify.destination.added")).toHaveLength(1);
  const list = await a.inject({ url: "/api/notify/destinations" });
  expect(list.json().destinations).toHaveLength(1);
  expect(list.json().destinations[0].endpoint).toBe(subscription.endpoint);
});

test("registering again is an update, not a second row", async () => {
  const a = await app();
  await register(a);
  await register(a);
  expect(store.list()).toHaveLength(1);
  expect(log.ofType("notify.destination.added")).toHaveLength(1);
});

test("a non-https endpoint or an unknown zone is refused", async () => {
  const a = await app();
  expect((await register(a, { subscription: { ...subscription, endpoint: "http://x" } })).statusCode).toBe(400);
  expect((await register(a, { timeZone: "Mars/Olympus" })).statusCode).toBe(400);
});

test("prefs, label and pause are updated and validated", async () => {
  const a = await app();
  const id = (await register(a)).json().destination.id;
  const prefs = { ...store.get(id)!.prefs, kinds: { "streamer.online": true } };
  const ok = await a.inject({ method: "PUT", url: `/api/notify/destinations/${id}`, payload: { prefs, enabled: false, label: "Phone" } });
  expect(ok.json().destination).toMatchObject({ enabled: false, label: "Phone", prefs: { kinds: { "streamer.online": true } } });
  const bad = await a.inject({ method: "PUT", url: `/api/notify/destinations/${id}`, payload: { prefs: { ...prefs, digestAt: "nine" } } });
  expect(bad.statusCode).toBe(400);
  const missing = await a.inject({ method: "PUT", url: "/api/notify/destinations/nope", payload: { enabled: true } });
  expect(missing.statusCode).toBe(404);
});

test("remove deletes and logs", async () => {
  const a = await app();
  const id = (await register(a)).json().destination.id;
  const res = await a.inject({ method: "POST", url: `/api/notify/destinations/${id}/remove` });
  expect(res.json()).toEqual({ ok: true });
  expect(store.list()).toHaveLength(0);
  expect(log.ofType("notify.destination.removed")).toHaveLength(1);
  expect((await a.inject({ method: "POST", url: `/api/notify/destinations/${id}/remove` })).statusCode).toBe(404);
});

test("test sends a test notification straight to that destination", async () => {
  const a = await app();
  const id = (await register(a)).json().destination.id;
  const res = await a.inject({ method: "POST", url: `/api/notify/destinations/${id}/test` });
  expect(res.json()).toEqual({ ok: true });
  expect(sendTo.mock.calls[0][1]).toMatchObject({ kind: NOTIFY_KIND.TEST, title: "Test notification" });
});

test("a failed test reports the error", async () => {
  sendTo.mockResolvedValueOnce({ ok: false, gone: false, error: "push service answered 403" });
  const a = await app();
  const id = (await register(a)).json().destination.id;
  const res = await a.inject({ method: "POST", url: `/api/notify/destinations/${id}/test` });
  expect(res.json()).toEqual({ ok: false, error: "push service answered 403" });
});

test("the inbox pages and clamps its limit", async () => {
  for (let i = 0; i < 3; i++) {
    store.addInbox({ ts: i, kind: NOTIFY_KIND.DROP_CLAIMED, title: `t${i}`, body: "", streamer: null, link: "/" });
  }
  const a = await app();
  const first = (await a.inject({ url: "/api/notify/inbox?limit=2" })).json().items;
  expect(first.map((r: { title: string }) => r.title)).toEqual(["t2", "t1"]);
  const rest = (await a.inject({ url: `/api/notify/inbox?before=${first[1].id}&limit=500` })).json().items;
  expect(rest.map((r: { title: string }) => r.title)).toEqual(["t0"]);
});

test("an action is carried out once, and a bad token is a 404", async () => {
  redeem.mockReturnValueOnce(true);
  const a = await app();
  const token = "a".repeat(64);
  expect((await a.inject({ method: "POST", url: "/api/notify/action", payload: { token } })).json()).toEqual({ ok: true });
  expect(redeem).toHaveBeenCalledWith(token);
  expect((await a.inject({ method: "POST", url: "/api/notify/action", payload: { token } })).statusCode).toBe(404);
  expect((await a.inject({ method: "POST", url: "/api/notify/action", payload: { token: "short" } })).statusCode).toBe(400);
});
