import { EventEmitter } from "node:events";
import type { History } from "../db/history.js";

export interface StreamerState {
  username: string;
  channelId: string | null;
  displayName: string | null;
  points: number | null;
  isOnline: boolean | null;
  pointsEnabled: boolean | null;
  error?: string;
}

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
      const data = await this.deps.client.request<{ streamers: StreamerState[] }>(
        "state", { streamers: usernames },
      );
      const before = JSON.stringify(this.streamers);
      this.streamers = data.streamers;
      this.lastUpdated = this.now();
      this.lastError = null;
      for (const s of data.streamers) {
        if (typeof s.points === "number") {
          this.deps.history.recordPoints(s.username, s.points, this.lastUpdated);
        }
      }
      if (before !== JSON.stringify(this.streamers)) {
        this.emit("change", this.snapshot());
      }
    } catch (cause) {
      // Keep the last known numbers; snapshot() will report them as stale.
      this.lastError = cause instanceof Error ? cause.message : String(cause);
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
