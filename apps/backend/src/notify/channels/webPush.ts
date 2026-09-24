import { existsSync, readFileSync, writeFileSync } from "node:fs";
// Default import only: web-push is CommonJS, and Node's ESM loader cannot
// see its exports as named imports even though TypeScript and Vitest can.
import webpush from "web-push";
import type { RequestOptions } from "web-push";
import { kindInfo, type Notification } from "../catalogue.js";
import type { Channel, SendResult } from "../notifier.js";
import type { Destination, PushSubscriptionJson } from "../store.js";

/**
 * Apple's push service rejects a `mailto:` at `localhost`, so the default
 * subject is this project's URL. `VAPID_SUBJECT` overrides it.
 */
export const DEFAULT_VAPID_SUBJECT = "https://github.com/vos/twitch-miner-control";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * Reads the key pair, or generates and writes one.
 *
 * The public key is baked into every browser subscription, so replacing
 * it strands them all until each browser next opens the app and
 * re-subscribes (lib/push.ts heals that). The file is created 0600
 * because the private key is what lets anyone push to those browsers.
 */
export function loadOrCreateVapid(
  path: string,
  generate: () => VapidKeys = () => webpush.generateVAPIDKeys(),
): VapidKeys {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VapidKeys>;
      if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch {
      // Unreadable: replaced below, which is the only way forward anyway.
    }
  }
  const keys = generate();
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

/** What the service worker receives. Mirrored in apps/frontend/src/sw/handlers.ts. */
export interface PushPayload {
  v: 1;
  kind: string;
  title: string;
  body: string;
  link: string;
  ts: number;
  /** Keeps the notification on screen until acted on. */
  urgent: boolean;
  tag?: string;
  dueAt?: number;
  actions?: Array<{ action: string; title: string; token: string }>;
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

export function payloadFor(n: Notification): PushPayload {
  return {
    v: 1,
    kind: n.kind,
    title: clip(n.title, 120),
    body: clip(n.body, 400),
    link: n.link,
    ts: n.ts,
    urgent: kindInfo(n.kind).urgency === "high" && n.followUp !== true,
    ...(n.tag === undefined ? {} : { tag: n.tag }),
    ...(n.dueAt === undefined ? {} : { dueAt: n.dueAt }),
    ...(n.actions === undefined || n.actions.length === 0 ? {} : {
      actions: n.actions.map((a) => ({ action: a.id, title: a.title, token: a.token })),
    }),
  };
}

/**
 * The `Topic` header: a push service replaces an undelivered message with
 * a newer one on the same topic. RFC 8030 limits it to 32 URL-safe base64
 * characters.
 */
export function topicFor(tag: string): string {
  return tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "tmc";
}

export type SendFn = (
  subscription: PushSubscriptionJson,
  payload: string,
  options: RequestOptions,
) => Promise<unknown>;

/** How long a single send waits for the push service before giving up. */
export const SEND_TIMEOUT_MS = 10_000;

export interface WebPushChannelDeps {
  vapid: VapidKeys;
  subject: string;
  send?: SendFn;
  sleep?: (ms: number) => Promise<void>;
  /** Wait before the single retry when the service gives no Retry-After. */
  retryDelayMs?: number;
}

type Attempt =
  | { kind: "done"; result: SendResult }
  | { kind: "retry"; delayMs: number; error: string };

const RETRY_CAP_MS = 60_000;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class WebPushChannel implements Channel {
  private readonly sendFn: SendFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelayMs: number;

  constructor(private readonly deps: WebPushChannelDeps) {
    this.sendFn = deps.send ?? ((subscription, payload, options) =>
      webpush.sendNotification(subscription, payload, options));
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryDelayMs = deps.retryDelayMs ?? 30_000;
  }

  async send(
    destination: Destination,
    n: Notification,
    options?: { retry?: boolean },
  ): Promise<SendResult> {
    const subscription = destination.subscription;
    if (subscription === null) return { ok: false, gone: true, error: "no push subscription" };
    const info = kindInfo(n.kind);
    const requestOptions: RequestOptions = {
      vapidDetails: {
        subject: this.deps.subject,
        publicKey: this.deps.vapid.publicKey,
        privateKey: this.deps.vapid.privateKey,
      },
      TTL: info.ttlSeconds,
      urgency: info.urgency,
      timeout: SEND_TIMEOUT_MS,
      ...(n.tag === undefined ? {} : { topic: topicFor(n.tag) }),
    };
    const payload = JSON.stringify(payloadFor(n));
    const first = await this.attempt(subscription, payload, requestOptions);
    if (first.kind === "done") return first.result;
    if (options?.retry === false) return { ok: false, gone: false, error: first.error };
    await this.sleep(first.delayMs);
    const second = await this.attempt(subscription, payload, requestOptions);
    return second.kind === "done" ? second.result : { ok: false, gone: false, error: second.error };
  }

  private async attempt(
    subscription: PushSubscriptionJson,
    payload: string,
    options: RequestOptions,
  ): Promise<Attempt> {
    try {
      await this.sendFn(subscription, payload, options);
      return { kind: "done", result: { ok: true } };
    } catch (cause) {
      const status = (cause as { statusCode?: unknown }).statusCode;
      if (typeof status !== "number") {
        return { kind: "retry", delayMs: this.retryDelayMs, error: `push service unreachable: ${messageOf(cause)}` };
      }
      const error = `push service answered ${status}`;
      if (status === 404 || status === 410) return { kind: "done", result: { ok: false, gone: true, error } };
      if (status === 429 || status >= 500) {
        return { kind: "retry", delayMs: retryAfterMs(cause) ?? this.retryDelayMs, error };
      }
      return { kind: "done", result: { ok: false, gone: false, error } };
    }
  }
}

function retryAfterMs(cause: unknown): number | null {
  const header = (cause as { headers?: Record<string, string> }).headers?.["retry-after"];
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, RETRY_CAP_MS) : null;
}
