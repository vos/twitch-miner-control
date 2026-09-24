/**
 * The service worker's behaviour, as plain functions over an injected
 * scope so they run under jsdom. sw.ts binds them to the real worker.
 *
 * Typed against these small interfaces rather than the WebWorker lib,
 * which cannot share a TypeScript program with the DOM lib the app uses.
 */

/** Mirrors PushPayload in apps/backend/src/notify/channels/webPush.ts. */
export interface PushPayload {
  v: 1;
  kind: string;
  title: string;
  body: string;
  link: string;
  ts: number;
  urgent: boolean;
  tag?: string;
  dueAt?: number;
  actions?: Array<{ action: string; title: string; token: string }>;
}

export interface NotificationData {
  link: string;
  actions: Array<{ action: string; token: string }>;
}

export interface NotificationOptionsLike {
  body: string;
  icon: string;
  data: NotificationData;
  tag?: string;
  timestamp?: number;
  requireInteraction?: boolean;
  renotify?: boolean;
  actions?: Array<{ action: string; title: string }>;
}

export interface SwNotification {
  data: unknown;
  close(): void;
}

export interface SwClient {
  url: string;
  focused?: boolean;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}

export interface SwScope {
  registration: { showNotification(title: string, options: NotificationOptionsLike): Promise<void> };
  clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly SwClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  location: { origin: string };
  fetch(
    input: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ ok: boolean }>;
}

export const ICON = "/icons/icon-192.png";
const APP_NAME = "Twitch Miner Control";

export function parsePayload(raw: string | null): PushPayload | null {
  if (raw === null) return null;
  try {
    const p = JSON.parse(raw) as Partial<PushPayload> | null;
    if (p?.v !== 1 || typeof p.title !== "string" || typeof p.body !== "string"
        || typeof p.link !== "string") return null;
    return p as PushPayload;
  } catch {
    return null;
  }
}

/** A pending restart names its time in the device's own clock and locale. */
export function titleFor(p: PushPayload): string {
  if (p.dueAt === undefined) return p.title;
  const time = new Date(p.dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Miner restarts at ${time}`;
}

export async function onPush(scope: SwScope, raw: string | null): Promise<void> {
  const p = parsePayload(raw);
  if (p === null) {
    // Shown regardless: Safari revokes a subscription whose pushes show nothing.
    await scope.registration.showNotification(APP_NAME, {
      body: "Something happened. Open the app for details.",
      icon: ICON,
      data: { link: "/", actions: [] },
    });
    return;
  }
  const actions = p.actions ?? [];
  await scope.registration.showNotification(titleFor(p), {
    body: p.body,
    icon: ICON,
    timestamp: p.ts,
    requireInteraction: p.urgent,
    data: { link: p.link, actions: actions.map(({ action, token }) => ({ action, token })) },
    actions: actions.map(({ action, title }) => ({ action, title })),
    // renotify is only valid with a tag; it makes a replacement alert again.
    ...(p.tag === undefined ? {} : { tag: p.tag, renotify: true }),
  });
}

export async function onNotificationClick(
  scope: SwScope,
  notification: SwNotification,
  action: string,
): Promise<void> {
  const data = notification.data as NotificationData | null;
  notification.close();
  const link = data?.link ?? "/";
  const token = data?.actions.find((a) => a.action === action)?.token;
  if (action === "cancel-restart" && token !== undefined) {
    let ok = false;
    try {
      const res = await scope.fetch("/api/notify/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    await scope.registration.showNotification(
      ok ? "Restart cancelled" : "Couldn't cancel the restart",
      {
        body: ok
          ? "The miner keeps watching the current channels."
          : "It may already have happened. Open the app to check.",
        icon: ICON,
        tag: "restart",
        data: { link, actions: [] },
      },
    );
    return;
  }
  await openLink(scope, link);
}

/** Focuses an open app window and routes it, or opens a new one. */
export async function openLink(scope: SwScope, link: string): Promise<void> {
  const url = new URL(link, scope.location.origin);
  if (url.origin !== scope.location.origin) {
    await scope.clients.openWindow(url.href);
    return;
  }
  const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
  const target = windows.find((c) => c.focused === true) ?? windows[0];
  if (target === undefined) {
    await scope.clients.openWindow(url.href);
    return;
  }
  await target.focus();
  target.postMessage({ type: "navigate", link: url.pathname + url.search });
}
