import { EventEmitter } from "node:events";
import type { History } from "../db/history.js";
import { downsample } from "./gains.js";

export interface StreamerState {
  username: string;
  channelId: string | null;
  displayName: string | null;
  points: number | null;
  isOnline: boolean | null;
  pointsEnabled: boolean | null;
  error?: string;
  /** Points gained over the last 24h; null when no prior balance is known. */
  gained24h: number | null;
  /** Points gained since this streamer came online; null when offline. */
  gainedStream: number | null;
  /** Downsampled 24h balances for the card sparkline. */
  spark: number[];
}

/** What the Python helper reports, before this service derives the rest. */
export type RawStreamerState = Omit<
  StreamerState,
  "gained24h" | "gainedStream" | "spark"
>;

const DAY_MS = 86_400_000;

export interface StateSnapshot {
  streamers: StreamerState[];
  lastUpdated: number | null;
  stale: boolean;
  error: string | null;
}

export interface StateServiceDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
  history: History;
  getStreamers: () => string[];
  intervalMs?: number;
  debounceMs?: number;
  staleAfterMs?: number;
  now?: () => number;
}

export class StateService extends EventEmitter {
  private streamers: StreamerState[] = [];
  private lastUpdated: number | null = null;
  private lastError: string | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private ticker: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private dirty = false;
  /**
   * Balance observed when each streamer was last seen going online.
   *
   * The anchor is the `isOnline` false->true transition this poller
   * observes, not an `events` row: the miner's event log records carry no
   * streamer identity (only `emoji` and `event`), so an online event
   * cannot be attributed to a channel without parsing log message text --
   * which the doorbell exists to avoid. The cost is that the anchor is
   * accurate to one refresh interval rather than to the second, which
   * rounds to nothing in a points-gained figure.
   */
  private streamAnchor = new Map<string, number>();

  constructor(private readonly deps: StateServiceDeps) {
    super();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  snapshot(): StateSnapshot {
    const staleAfter = this.deps.staleAfterMs ?? 180_000;
    const age = this.lastUpdated === null ? Infinity : this.now() - this.lastUpdated;
    // A failed refresh means the numbers we're holding are exactly as old
    // as the last *successful* refresh, even though little wall-clock
    // time has passed since we last tried -- so a live error always marks
    // the snapshot stale, independent of the age check below.
    return {
      streamers: this.streamers,
      lastUpdated: this.lastUpdated,
      stale: this.lastError !== null || age > staleAfter,
      error: this.lastError,
    };
  }

  async refresh(): Promise<void> {
    if (this.inFlight) {
      // Something new arrived while a refresh was already in flight (a
      // doorbell event, a concurrent caller, or the 60s tick). The
      // in-flight request was built from data that's now out of date, so
      // returning it as-is would silently drop this arrival -- the
      // dashboard would then sit still until the *next* unrelated
      // trigger, degrading the doorbell to plain polling. Mark dirty so
      // the in-flight refresh's completion handler starts exactly one
      // follow-up; many arrivals during the same window all set the same
      // flag, so they coalesce into that single follow-up rather than
      // queuing one round trip per arrival.
      this.dirty = true;
      return this.inFlight;
    }
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
      if (this.dirty) {
        this.dirty = false;
        // Fire-and-forget: callers awaiting *this* refresh() only wait
        // for the request that was in flight when they called it, not
        // for a coalesced follow-up triggered after the fact. The
        // follow-up must run whether the just-finished refresh succeeded
        // or failed -- doRefresh() never rejects (see its own try/catch),
        // so this always executes.
        void this.refresh();
      }
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    const usernames = this.deps.getStreamers();
    if (usernames.length === 0) {
      // An empty streamer list is fully up to date -- there is nothing
      // outstanding to fetch, so this is a *successful* refresh, not a
      // stale leftover. Mirror the success path: clear any previous
      // error, stamp lastUpdated so staleness is computed from now, and
      // emit "change" only when the streamer list actually changed (i.e.
      // it was non-empty before). Skipping any of this would leave
      // deleted streamers rendered forever, reported as "fresh" once
      // lastUpdated ages past staleAfterMs from a stale prior value.
      const hadStreamers = this.streamers.length > 0;
      this.streamers = [];
      this.lastUpdated = this.now();
      this.lastError = null;
      if (hadStreamers) {
        this.emit("change", this.snapshot());
      }
      return;
    }
    try {
      const data = await this.deps.client.request<{ streamers: RawStreamerState[] }>(
        "state", { streamers: usernames },
      );
      const before = JSON.stringify(this.streamers);
      const previous = new Map(this.streamers.map((s) => [s.username, s]));
      const at = this.now();
      this.lastUpdated = at;
      this.lastError = null;
      const dayAgo = at - DAY_MS;

      this.streamers = data.streamers.map((s) => {
        if (typeof s.points === "number") {
          this.deps.history.recordPoints(s.username, s.points, at);
        }

        const wasOnline = previous.get(s.username)?.isOnline ?? null;
        if (s.isOnline && wasOnline === false && typeof s.points === "number") {
          this.streamAnchor.set(s.username, s.points);
        }
        if (!s.isOnline) {
          this.streamAnchor.delete(s.username);
        }

        const past = this.deps.history.balanceAt(s.username, dayAgo);
        const anchor = this.streamAnchor.get(s.username);

        return {
          ...s,
          gained24h:
            past === null || typeof s.points !== "number" ? null : s.points - past,
          gainedStream:
            anchor === undefined || typeof s.points !== "number"
              ? null
              : s.points - anchor,
          spark: downsample(this.deps.history.seriesSince(s.username, dayAgo), dayAgo, at),
        };
      });

      if (before !== JSON.stringify(this.streamers)) {
        this.emit("change", this.snapshot());
      }
    } catch (cause) {
      // Keep the last known numbers; snapshot() will report them as stale.
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      // `code: "AUTH"` is state.py's verdict that it reloaded the cookie
      // pickle and still could not authenticate, i.e. the Twitch session is
      // dead rather than the request flaky. Re-emitted as its own event so
      // the HTTP layer can turn it into a visible "sign in again" prompt;
      // duck-typed on `code` rather than `instanceof NdjsonError` so a
      // stubbed client in a test can raise one without importing the
      // helper transport.
      if ((cause as { code?: unknown } | null)?.code === "AUTH") {
        this.emit("auth-error", cause);
      }
      this.emit("change", this.snapshot());
    }
  }

  /** Doorbell: something happened, refresh soon. Bursts coalesce. */
  ring(eventType: string): void {
    this.deps.history.recordEvent(eventType, this.now());
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh();
    }, this.deps.debounceMs ?? 2000);
  }

  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.refresh(), this.deps.intervalMs ?? 60_000);
    // Arming the interval alone left the first tick a full period away, so
    // for 60s after every restart the dashboard rendered a confident total
    // of 0 built from no data at all. Kick one refresh immediately so the
    // snapshot is either real or explicitly "never updated" -- never a
    // fabricated zero. Fire-and-forget: doRefresh() never rejects, and
    // start() must not block boot on a Twitch round trip.
    void this.refresh();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.ticker = null;
    this.debounceTimer = null;
    // Clear any pending dirty flag so an in-flight refresh that settles
    // after stop() cannot resurrect a follow-up request -- stop() must
    // leave nothing pending.
    this.dirty = false;
  }
}
