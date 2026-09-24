import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  deviceLabel, enable, heal, support, toBase64Url, urlBase64ToUint8Array, type PushEnv,
} from "./push.js";

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  secure: true, serviceWorker: true, pushManager: true, permission: "default",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36",
  maxTouchPoints: 0, standalone: false, ...over,
});

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1";

test("support explains the first thing in the way", () => {
  expect(support(env({ secure: false }))).toBe("insecure");
  expect(support(env({ userAgent: IPHONE }))).toBe("ios-install");
  expect(support(env({ userAgent: IPHONE, standalone: true }))).toBe("ok");
  expect(support(env({ pushManager: false }))).toBe("unsupported");
  expect(support(env({ permission: null }))).toBe("unsupported");
  expect(support(env({ permission: "denied" }))).toBe("denied");
  expect(support(env())).toBe("ok");
});

test("an iPad asking for the desktop site is still iOS", () => {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15";
  expect(support(env({ userAgent: ua, maxTouchPoints: 5 }))).toBe("ios-install");
  expect(support(env({ userAgent: ua, maxTouchPoints: 0 }))).toBe("ok");
});

test("a device label names the browser and the platform", () => {
  expect(deviceLabel("Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36")).toBe("Chrome on Android");
  expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0")).toBe("Edge on Windows");
  expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on Linux");
  expect(deviceLabel(IPHONE)).toBe("Safari on iPhone");
});

test("VAPID keys survive the base64url round trip", () => {
  const key = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
  expect(toBase64Url(urlBase64ToUint8Array(key).buffer as ArrayBuffer)).toBe(key);
});

// --- against a fake browser ---

const KEY = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_KEY = "BAhFXcDNbuPtf8RK2Qp_LFaVbSxpJAUht74Fz9W8i7i9QmBlAYmp9OiM9MuEAVHbC62UkgfgXMj9nC-e9YevF84";

function fakeSubscription(endpoint: string, key: string) {
  return {
    endpoint,
    options: { applicationServerKey: urlBase64ToUint8Array(key).buffer },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "p", auth: "a" } }),
  };
}

let posted: Array<{ url: string; body: unknown }>;
let current: ReturnType<typeof fakeSubscription> | null;
let subscribe: ReturnType<typeof vi.fn>;

beforeEach(() => {
  posted = [];
  current = null;
  subscribe = vi.fn(async () => (current = fakeSubscription("https://push.example/new", KEY)));
  const registration = { pushManager: { subscribe, getSubscription: async () => current } };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(async () => registration),
    },
  });
  vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn(async () => "granted") });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 200, json: async () => ({ destination: { id: "d1", endpoint: current?.endpoint } }) };
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
});

test("enable asks, subscribes with the server's key and registers this browser", async () => {
  const destination = await enable(KEY);
  expect(destination.id).toBe("d1");
  const options = subscribe.mock.calls[0][0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
  expect(options.userVisibleOnly).toBe(true);
  expect(toBase64Url(options.applicationServerKey.buffer as ArrayBuffer)).toBe(KEY);
  expect(posted[0]).toMatchObject({
    url: "/api/notify/destinations",
    body: {
      subscription: { endpoint: "https://push.example/new" },
      label: expect.any(String),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  });
});

test("enable stops at a refused permission", async () => {
  vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn(async () => "denied") });
  await expect(enable(KEY)).rejects.toThrow(/blocked/);
  expect(subscribe).not.toHaveBeenCalled();
});

const known = (endpoint: string) => [{ endpoint } as never];

test("heal leaves a healthy subscription alone", async () => {
  current = fakeSubscription("https://push.example/a", KEY);
  expect(await heal(KEY, known("https://push.example/a"))).toBe("https://push.example/a");
  expect(subscribe).not.toHaveBeenCalled();
  expect(posted).toEqual([]);
});

test("heal re-subscribes after the server's key changed, keeping the old row", async () => {
  const old = fakeSubscription("https://push.example/old", OTHER_KEY);
  current = old;
  expect(await heal(KEY, known("https://push.example/old"))).toBe("https://push.example/new");
  expect(old.unsubscribe).toHaveBeenCalled();
  expect(posted[0].body).toMatchObject({ previousEndpoint: "https://push.example/old" });
});

test("heal respects a removal made from another device", async () => {
  const sub = fakeSubscription("https://push.example/a", KEY);
  current = sub;
  expect(await heal(KEY, [])).toBeNull();
  expect(sub.unsubscribe).toHaveBeenCalled();
  expect(posted).toEqual([]);
});

test("heal does nothing where push was never turned on", async () => {
  expect(await heal(KEY, [])).toBeNull();
  expect(subscribe).not.toHaveBeenCalled();
});
