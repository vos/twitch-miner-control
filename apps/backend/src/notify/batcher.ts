import { NOTIFY_KIND, kindInfo, type Notification } from "./catalogue.js";

/**
 * Collects items per key for a fixed window after the first one arrives,
 * then hands them over together. The window never extends: a steady
 * trickle still flushes every `windowMs`.
 */
export class Batcher<T> {
  private readonly buckets = new Map<string, { items: T[]; timer: NodeJS.Timeout }>();

  constructor(
    private readonly windowMs: number,
    private readonly flush: (key: string, items: T[]) => void,
  ) {}

  add(key: string, item: T): void {
    const bucket = this.buckets.get(key);
    if (bucket !== undefined) {
      bucket.items.push(item);
      return;
    }
    const items = [item];
    const timer = setTimeout(() => {
      this.buckets.delete(key);
      this.flush(key, items);
    }, this.windowMs);
    // A pending batch must not hold the process open at shutdown.
    timer.unref();
    this.buckets.set(key, { items, timer });
  }

  /** Drops anything still waiting. */
  stop(): void {
    for (const bucket of this.buckets.values()) clearTimeout(bucket.timer);
    this.buckets.clear();
  }
}

/** "a, b, c and 2 more". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** One notification standing for a burst of the same kind. */
export function combine(items: readonly Notification[]): Notification {
  if (items.length === 1) return items[0];
  const last = items[items.length - 1];
  const base = { kind: last.kind, ts: last.ts };
  if (last.kind === NOTIFY_KIND.STREAMER_ONLINE) {
    return {
      ...base,
      title: `${items.length} streamers went live`,
      body: listNames(items.map((i) => i.streamer?.name ?? i.title)),
      link: "/?open=dashboard",
    };
  }
  if (last.kind === NOTIFY_KIND.DROP_CLAIMED) {
    return {
      ...base,
      title: `${items.length} drops claimed`,
      body: items.map((i) => i.body).join(" · "),
      link: "/?open=drops",
    };
  }
  return {
    ...base,
    title: `${kindInfo(last.kind).label} (${items.length})`,
    body: items.map((i) => i.body).join(" · "),
    link: last.link,
  };
}
