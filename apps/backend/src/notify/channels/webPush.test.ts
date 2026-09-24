import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { NOTIFY_KIND, type Notification } from "../catalogue.js";
import { defaultPrefs } from "../prefs.js";
import type { Destination } from "../store.js";
import { SEND_TIMEOUT_MS, WebPushChannel, loadOrCreateVapid, payloadFor, topicFor } from "./webPush.js";

const dest = (over: Partial<Destination> = {}): Destination => ({
  id: "d1", channel: "webpush", label: "Chrome", endpoint: "https://push.example/a",
  subscription: { endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } },
  prefs: defaultPrefs("UTC"), enabled: true, createdTs: 1,
  lastOkTs: null, lastError: null, lastErrorTs: null, ...over,
});

const pending: Notification = {
  kind: NOTIFY_KIND.RESTART_PENDING, title: "Miner restart pending", body: "Because.",
  ts: 10, link: "/?open=dashboard", tag: "restart", dueAt: 190_000,
  actions: [{ id: "cancel-restart", title: "Cancel restart", token: "t".repeat(64) }],
};

const vapid = { publicKey: "pub", privateKey: "priv" };
const statusError = (statusCode: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`status ${statusCode}`), { statusCode, headers });

test("keys are generated once and then reused", () => {
  const path = join(mkdtempSync(join(tmpdir(), "vapid-")), "vapid.json");
  const generate = vi.fn(() => ({ publicKey: "A", privateKey: "B" }));
  expect(loadOrCreateVapid(path, generate)).toEqual({ publicKey: "A", privateKey: "B" });
  expect(loadOrCreateVapid(path, generate)).toEqual({ publicKey: "A", privateKey: "B" });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, "utf8")).publicKey).toBe("A");
});

test("an unreadable key file is replaced", () => {
  const path = join(mkdtempSync(join(tmpdir(), "vapid-")), "vapid.json");
  writeFileSync(path, "{}");
  expect(loadOrCreateVapid(path, () => ({ publicKey: "C", privateKey: "D" })).publicKey).toBe("C");
});

test("the payload carries what the service worker needs, and no more", () => {
  expect(payloadFor(pending)).toEqual({
    v: 1, kind: "restart.pending", title: "Miner restart pending", body: "Because.",
    link: "/?open=dashboard", ts: 10, urgent: true, tag: "restart", dueAt: 190_000,
    actions: [{ action: "cancel-restart", title: "Cancel restart", token: "t".repeat(64) }],
  });
});

test("a follow-up is never urgent", () => {
  expect(payloadFor({ ...pending, followUp: true, actions: undefined }).urgent).toBe(false);
});

test("long text is clipped", () => {
  const p = payloadFor({ ...pending, body: "x".repeat(2_000) });
  expect(p.body.length).toBeLessThanOrEqual(400);
});

test("a topic keeps to the header's alphabet and length", () => {
  expect(topicFor("miner-health")).toBe("miner-health");
  expect(topicFor("a b/c".repeat(20))).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
});

test("a send passes VAPID, TTL, urgency and topic", async () => {
  const send = vi.fn(async () => ({ statusCode: 201 }));
  const channel = new WebPushChannel({ vapid, subject: "https://example.org", send });
  await expect(channel.send(dest(), pending)).resolves.toEqual({ ok: true });
  const [subscription, payload, options] = send.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>];
  expect(subscription).toEqual(dest().subscription);
  expect(JSON.parse(payload).kind).toBe("restart.pending");
  expect(options).toMatchObject({
    vapidDetails: { subject: "https://example.org", publicKey: "pub", privateKey: "priv" },
    TTL: 180, urgency: "high", topic: "restart", timeout: SEND_TIMEOUT_MS,
  });
});

test("404 and 410 mean the subscription is gone", async () => {
  for (const status of [404, 410]) {
    const channel = new WebPushChannel({
      vapid, subject: "s", send: async () => { throw statusError(status); },
    });
    await expect(channel.send(dest(), pending)).resolves.toMatchObject({ ok: false, gone: true });
  }
});

test("a 5xx is retried once after the delay, then reported", async () => {
  const sleep = vi.fn(async () => {});
  const send = vi.fn(async () => { throw statusError(503); });
  const channel = new WebPushChannel({ vapid, subject: "s", send, sleep, retryDelayMs: 30_000 });
  await expect(channel.send(dest(), pending)).resolves.toEqual({
    ok: false, gone: false, error: "push service answered 503",
  });
  expect(send).toHaveBeenCalledTimes(2);
  expect(sleep).toHaveBeenCalledWith(30_000);
});

test("retry: false reports a 503 without waiting or trying a second time", async () => {
  const sleep = vi.fn(async () => {});
  const send = vi.fn(async () => { throw statusError(503); });
  const channel = new WebPushChannel({ vapid, subject: "s", send, sleep, retryDelayMs: 30_000 });
  await expect(channel.send(dest(), pending, { retry: false })).resolves.toEqual({
    ok: false, gone: false, error: "push service answered 503",
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

test("a 429 honours Retry-After, capped at a minute", async () => {
  const sleep = vi.fn(async () => {});
  const send = vi.fn()
    .mockRejectedValueOnce(statusError(429, { "retry-after": "600" }))
    .mockResolvedValueOnce({ statusCode: 201 });
  const channel = new WebPushChannel({ vapid, subject: "s", send, sleep });
  await expect(channel.send(dest(), pending)).resolves.toEqual({ ok: true });
  expect(sleep).toHaveBeenCalledWith(60_000);
});

test("a network error is retried too", async () => {
  const send = vi.fn()
    .mockRejectedValueOnce(new Error("ECONNRESET"))
    .mockResolvedValueOnce({ statusCode: 201 });
  const channel = new WebPushChannel({ vapid, subject: "s", send, sleep: async () => {} });
  await expect(channel.send(dest(), pending)).resolves.toEqual({ ok: true });
});

test("any other 4xx is reported without a retry", async () => {
  const send = vi.fn(async () => { throw statusError(413); });
  const channel = new WebPushChannel({ vapid, subject: "s", send, sleep: async () => {} });
  await expect(channel.send(dest(), pending)).resolves.toMatchObject({ ok: false, gone: false });
  expect(send).toHaveBeenCalledTimes(1);
});

test("a destination without a subscription is gone", async () => {
  const channel = new WebPushChannel({ vapid, subject: "s", send: vi.fn() });
  await expect(channel.send(dest({ subscription: null }), pending))
    .resolves.toMatchObject({ ok: false, gone: true });
});
