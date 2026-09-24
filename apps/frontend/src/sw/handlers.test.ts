import { expect, test, vi } from "vitest";
import {
  ICON, onNotificationClick, onPush, type NotificationOptionsLike, type SwClient,
} from "./handlers.js";

function fakeScope(windows: SwClient[] = [], fetchOk = true) {
  const shown: Array<[string, NotificationOptionsLike]> = [];
  const scope = {
    registration: {
      showNotification: vi.fn(async (title: string, options: NotificationOptionsLike) => {
        shown.push([title, options]);
      }),
    },
    clients: {
      matchAll: vi.fn(async () => windows),
      openWindow: vi.fn(async () => undefined),
    },
    location: { origin: "https://miner.example" },
    fetch: vi.fn(async () => ({ ok: fetchOk })),
  };
  return { scope, shown };
}

const payload = (over: object = {}) => JSON.stringify({
  v: 1, kind: "drop.claimed", title: "Drop claimed", body: "Claim X", link: "/?open=drops",
  ts: 123, urgent: false, ...over,
});

test("a push shows its title and body, keeping the link for a click", async () => {
  const { scope, shown } = fakeScope();
  await onPush(scope, payload());
  expect(shown).toEqual([["Drop claimed", {
    body: "Claim X", icon: ICON, timestamp: 123, requireInteraction: false,
    data: { link: "/?open=drops", actions: [] }, actions: [],
  }]]);
});

test("a tagged push replaces the last one and alerts again", async () => {
  const { scope, shown } = fakeScope();
  await onPush(scope, payload({ tag: "miner-health", urgent: true }));
  expect(shown[0][1]).toMatchObject({ tag: "miner-health", renotify: true, requireInteraction: true });
});

test("a pending restart shows the device's own clock time and a Cancel button", async () => {
  const { scope, shown } = fakeScope();
  const dueAt = Date.UTC(2026, 8, 23, 12, 32);
  await onPush(scope, payload({
    kind: "restart.pending", title: "Miner restart pending", tag: "restart", dueAt,
    actions: [{ action: "cancel-restart", title: "Cancel restart", token: "t".repeat(64) }],
  }));
  const time = new Date(dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  expect(shown[0][0]).toBe(`Miner restarts at ${time}`);
  expect(shown[0][1].actions).toEqual([{ action: "cancel-restart", title: "Cancel restart" }]);
  expect(shown[0][1].data.actions).toEqual([{ action: "cancel-restart", token: "t".repeat(64) }]);
});

test("an unreadable push still shows a notification", async () => {
  const { scope, shown } = fakeScope();
  await onPush(scope, "not json");
  await onPush(scope, null);
  expect(shown).toHaveLength(2);
  expect(shown[0][0]).toBe("Twitch Miner Control");
});

const notification = (data: unknown) => ({ data, close: vi.fn() });
const restartData = {
  link: "/?open=dashboard",
  actions: [{ action: "cancel-restart", token: "t".repeat(64) }],
};

test("Cancel posts the token and replaces the notification", async () => {
  const { scope, shown } = fakeScope();
  const n = notification(restartData);
  await onNotificationClick(scope, n, "cancel-restart");
  expect(n.close).toHaveBeenCalled();
  expect(scope.fetch).toHaveBeenCalledWith("/api/notify/action", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "t".repeat(64) }),
  });
  expect(shown[0]).toEqual(["Restart cancelled", expect.objectContaining({ tag: "restart" })]);
  expect(scope.clients.openWindow).not.toHaveBeenCalled();
});

test("a refused Cancel says so", async () => {
  const { scope, shown } = fakeScope([], false);
  await onNotificationClick(scope, notification(restartData), "cancel-restart");
  expect(shown[0][0]).toBe("Couldn't cancel the restart");
});

test("a click focuses an open window and tells it where to go", async () => {
  const win = { url: "https://miner.example/", focused: false, focus: vi.fn(async () => {}), postMessage: vi.fn() };
  const { scope } = fakeScope([win]);
  await onNotificationClick(scope, notification({ link: "/?open=drops&campaign=c1", actions: [] }), "");
  expect(win.focus).toHaveBeenCalled();
  expect(win.postMessage).toHaveBeenCalledWith({ type: "navigate", link: "/?open=drops&campaign=c1" });
  expect(scope.clients.openWindow).not.toHaveBeenCalled();
});

test("a click with no window open opens one at the link", async () => {
  const { scope } = fakeScope();
  await onNotificationClick(scope, notification({ link: "/?open=logs", actions: [] }), "");
  expect(scope.clients.openWindow).toHaveBeenCalledWith("https://miner.example/?open=logs");
});

test("an outside link opens in a new window", async () => {
  const win = { url: "https://miner.example/", focus: vi.fn(async () => {}), postMessage: vi.fn() };
  const { scope } = fakeScope([win]);
  const link = "https://github.com/vos/twitch-miner-control/releases/tag/v1.6.0";
  await onNotificationClick(scope, notification({ link, actions: [] }), "");
  expect(scope.clients.openWindow).toHaveBeenCalledWith(link);
  expect(win.postMessage).not.toHaveBeenCalled();
});
