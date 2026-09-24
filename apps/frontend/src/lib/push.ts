import { notifyApi, type Destination } from "../api/notify.js";

export type PushSupport = "ok" | "insecure" | "ios-install" | "unsupported" | "denied";

/** What decides whether this browser can receive push. */
export interface PushEnv {
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  /** Null when the Notification API is missing entirely. */
  permission: NotificationPermission | null;
  userAgent: string;
  maxTouchPoints: number;
  /** Opened from the Home Screen, which iOS requires for push. */
  standalone: boolean;
}

export function readEnv(): PushEnv {
  return {
    secure: window.isSecureContext,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    permission: typeof Notification === "undefined" ? null : Notification.permission,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: window.matchMedia("(display-mode: standalone)").matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true,
  };
}

/** An iPad asking for the desktop site reports itself as a Mac with a touch screen. */
export function isIos(env: Pick<PushEnv, "userAgent" | "maxTouchPoints">): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent)
    || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
}

/** The first thing standing in the way, in the order a user can fix them. */
export function support(env: PushEnv = readEnv()): PushSupport {
  if (!env.secure) return "insecure";
  if (isIos(env) && !env.standalone) return "ios-install";
  if (!env.serviceWorker || !env.pushManager || env.permission === null) return "unsupported";
  if (env.permission === "denied") return "denied";
  return "ok";
}

/** A starting name for this browser; the user can rename it. */
export function deviceLabel(ua: string): string {
  const browser = /Edg\//.test(ua) ? "Edge"
    : /Firefox\/|FxiOS\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const platform = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "this device";
  return `${browser} on ${platform}`;
}

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const base64 = (value + "=".repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function toBase64Url(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class PermissionDeniedError extends Error {
  constructor() {
    super("Notifications are blocked for this site. Allow them in the browser's site settings.");
  }
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

async function existingSubscription(): Promise<{
  reg: ServiceWorkerRegistration;
  sub: PushSubscription;
} | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  return reg === undefined || sub == null ? null : { reg, sub };
}

const subscribeWith = (reg: ServiceWorkerRegistration, key: string) =>
  reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });

/**
 * Turns push on for this browser. Call it straight from the click
 * handler: iOS and Firefox only show the permission prompt for a gesture.
 */
export async function enable(vapidPublicKey: string): Promise<Destination> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new PermissionDeniedError();
  const reg = await registration();
  const sub = await subscribeWith(reg, vapidPublicKey);
  const { destination } = await notifyApi.register({
    subscription: sub.toJSON(),
    label: deviceLabel(navigator.userAgent),
    timeZone: timeZone(),
  });
  return destination;
}

/** This browser's push endpoint, which is how it finds its own row. */
export async function currentEndpoint(): Promise<string | null> {
  return (await existingSubscription())?.sub.endpoint ?? null;
}

export async function disable(destinationId: string | null): Promise<void> {
  await (await existingSubscription())?.sub.unsubscribe();
  if (destinationId !== null) await notifyApi.remove(destinationId);
}

/**
 * Brings this browser's subscription back in line with the server.
 *
 * - Same key, and the server knows it: nothing to do.
 * - Same key, and the server does not: removed from another device, so
 *   unsubscribe here too rather than quietly re-registering.
 * - Different key: vapid.json was replaced. Re-subscribe, and name the
 *   old endpoint so the row keeps its label and preferences.
 *
 * Returns this browser's endpoint while push is on here, else null.
 */
export async function heal(
  vapidPublicKey: string,
  known: readonly Pick<Destination, "endpoint">[],
): Promise<string | null> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
  const existing = await existingSubscription();
  if (existing === null) return null;
  const { reg, sub } = existing;
  const key = sub.options.applicationServerKey;
  const sameKey = key !== null && toBase64Url(key) === vapidPublicKey;
  if (sameKey && known.some((d) => d.endpoint === sub.endpoint)) return sub.endpoint;
  await sub.unsubscribe();
  if (sameKey) return null;
  const fresh = await subscribeWith(reg, vapidPublicKey);
  await notifyApi.register({
    subscription: fresh.toJSON(),
    label: deviceLabel(navigator.userAgent),
    timeZone: timeZone(),
    previousEndpoint: sub.endpoint,
  });
  return fresh.endpoint;
}

/** heal() on app start, where a failure just waits for the next visit. */
export async function healOnStart(): Promise<void> {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const [config, { destinations }] = await Promise.all([
      notifyApi.config(), notifyApi.destinations(),
    ]);
    await heal(config.vapidPublicKey, destinations);
  } catch {
    // Retried on the next visit.
  }
}
