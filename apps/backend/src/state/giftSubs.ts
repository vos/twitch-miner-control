import { EventEmitter } from "node:events";
import { normaliseUsername } from "./roster.js";

/** One gifted subscription the account holds, as helpers/state.py reports it. */
export interface GiftSub {
  id: string;
  /** 1, 2 or 3; "Custom" for a product without a numbered tier (Turbo). */
  tier: number | string;
  /** Twitch's product name, e.g. "KDRkitten Sub" or "Twitch Turbo". */
  product: string;
  /** Null for an anonymous gift. */
  gifter: { login: string; displayName: string } | null;
  /** Null for a gift that is not for a channel (Turbo). */
  target: { channelId: string; login: string; displayName: string } | null;
  /** Epoch ms. */
  endsAt: number;
}

export interface GiftSubsResult {
  giftSubs: GiftSub[];
  /** Why the last refresh failed, or null when it worked. */
  error: string | null;
}

export interface GiftSubsDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
  now?: () => number;
}

/**
 * The account's active gift subs, fetched only when something says they
 * may have changed.
 *
 * There is no timer. The miner already watches for new gifts (PubSub plus
 * its own 30-minute sync) and rings GIFT_SUB_RECEIVED for each one, so
 * index.ts refetches on that event, on boot and on every miner start --
 * the miner's first sync after a start is silent, so a gift that arrived
 * while it was down produces no event. What the miner never reports at
 * all is a gift for a channel it does not watch, or one with no channel;
 * the dashboard's refresh button covers those.
 *
 * Expiry needs no fetch either: the miner sends no event for it, and
 * `endsAt` already says when, so active() filters on read.
 *
 * Emits "change" when a fetch returns a different list. A failed fetch
 * keeps the last list: an empty one would claim the gifts are gone.
 */
export class GiftSubsCache extends EventEmitter {
  private gifts: GiftSub[] = [];
  private error: string | null = null;
  private inflight: Promise<GiftSubsResult> | null = null;

  constructor(private readonly deps: GiftSubsDeps) {
    super();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Never rejects. Overlapping calls share one fetch. */
  refresh(): Promise<GiftSubsResult> {
    if (this.inflight !== null) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await this.deps.client.request<{ giftSubs: GiftSub[] }>("gift_subs");
        const next = res.giftSubs ?? [];
        const changed = JSON.stringify(next) !== JSON.stringify(this.gifts);
        this.gifts = next;
        this.error = null;
        if (changed) this.emit("change");
      } catch (cause) {
        // Never the message itself: a failed GQL call's is three stacked
        // Python tracebacks, and the dashboard shows this text as is.
        // `code: "AUTH"` is state.py's verdict that the session is dead.
        this.error = (cause as { code?: unknown } | null)?.code === "AUTH"
          ? "Twitch sign-in needed. Sign in again, then refresh."
          : "Twitch did not answer. Try again in a moment.";
      } finally {
        this.inflight = null;
      }
      return { giftSubs: this.active(), error: this.error };
    })();
    return this.inflight;
  }

  /** Gifts that have not ended yet, in the order Twitch listed them. */
  active(): GiftSub[] {
    const at = this.now();
    return this.gifts.filter((g) => g.endsAt > at);
  }

  /**
   * The active gift for one channel, or null.
   *
   * By id where the caller has one, else by login: a card painted from
   * the database carries no channel id until the live pass lands.
   */
  forChannel(channelId: string | null, login: string): GiftSub | null {
    const name = normaliseUsername(login);
    return this.active().find((g) => g.target !== null && (
      channelId !== null ? g.target.channelId === channelId : g.target.login === name
    )) ?? null;
  }
}

/**
 * The triggers that stand in for a timer; see GiftSubsCache. Boot and the
 * refresh button call refresh() directly.
 */
export function watchGiftSubs(deps: {
  giftSubs: Pick<GiftSubsCache, "refresh">;
  supervisor: Pick<EventEmitter, "on">;
  stateService: Pick<EventEmitter, "on">;
}): void {
  deps.supervisor.on("state", (state: string) => {
    if (state === "RUNNING") void deps.giftSubs.refresh();
  });
  deps.stateService.on("event", (row: { type: string }) => {
    if (row.type === "GIFT_SUB_RECEIVED") void deps.giftSubs.refresh();
  });
}
