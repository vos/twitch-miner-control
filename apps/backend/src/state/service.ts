import { EventEmitter } from "node:events";
import type { History } from "../db/history.js";
import { attribute } from "./attribute.js";
import { downsample } from "./gains.js";
import { normaliseUsername } from "./roster.js";

export interface StreamerState {
  username: string;
  channelId: string | null;
  displayName: string | null;
  points: number | null;
  isOnline: boolean | null;
  pointsEnabled: boolean | null;
  error?: string;
  /**
   * Points gained over the last 24h -- or over however much history exists,
   * when the streamer has been tracked for less than a day. Null only when
   * there is no *earlier* balance at all to compare against.
   */
  gained24h: number | null;
  /**
   * Start of the window `gained24h` covers when that window is *shorter*
   * than 24h, so the UI can label it honestly instead of calling three
   * hours "24h". Null when the window is full (the label is just "24h")
   * and whenever `gained24h` is null -- a full window must not report the
   * moving cutoff, which would make every tick a fresh SSE frame.
   */
  gainedSince: number | null;
  /** Points gained since this streamer came online; null when offline. */
  gainedStream: number | null;
  /** Downsampled 24h balances for the card sparkline. */
  spark: number[];
  /**
   * Twitch CDN profile picture URL, or null when the channel has none or
   * we have not resolved it yet. A stable string, so it can join the
   * change comparison without waking SSE clients every tick.
   */
  avatarUrl: string | null;
}

/** What the Python helper reports, before this service derives the rest. */
export type RawStreamerState = Omit<
  StreamerState,
  "gained24h" | "gainedSince" | "gainedStream" | "spark" | "avatarUrl"
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
  getStreamers: () => string[] | Promise<string[]>;
  intervalMs?: number;
  debounceMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  /**
   * Optional so tests (and a boot before the cache exists) can run
   * without one. Absent, every streamer simply reports a null avatar.
   */
  avatars?: { resolve(logins: string[]): Promise<Map<string, string | null>> };
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
   * observes, not an `events` row. An event row now carries the miner's
   * formatted message, so it does name a channel -- but only as display
   * text whose balances are millified and lossy, so attributing an anchor
   * would mean parsing numbers back out of prose. The poller's balances
   * are exact, so they stay the source. The cost is that the anchor is
   * accurate to one refresh interval rather than to the second, which
   * rounds to nothing in a points-gained figure.
   */
  private streamAnchor = new Map<string, number>();
  /**
   * The roster from the last refresh, used to attribute doorbell events.
   * Empty before the first refresh, so early events are unattributed
   * rather than misattributed.
   */
  private roster: string[] = [];

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

  /**
   * The baseline a gain is measured from, plus the moment it describes.
   *
   * Prefers the balance in force at `from` -- a full window. When the
   * streamer has been tracked for less than that, falls back to its
   * earliest snapshot: a partial window is a real number over a real span,
   * and withholding it left a new streamer showing nothing for a day
   * despite the history to compute it sitting in the table.
   *
   * Returns null only when the sole snapshot is the one this very tick
   * just wrote. There is no *elapsed* time then, so any figure would be a
   * confident "+0" about a window that has not happened yet -- the one
   * case the em dash is actually telling the truth about.
   */
  private gainWindow(
    username: string,
    from: number,
  ): { ts: number | null; balance: number } | null {
    const earliest = this.deps.history.earliestSample(username);
    if (earliest === null || earliest.ts >= this.now()) return null;
    if (earliest.ts <= from) {
      const past = this.deps.history.balanceAt(username, from);
      // A full window needs no span: the label is simply "24h". Reporting
      // the cutoff here would encode "now" into a derived field, so every
      // tick would differ from the last and wake every SSE client with a
      // payload nothing actually changed in.
      if (past !== null) return { ts: null, balance: past };
    }
    return earliest;
  }

  private async doRefresh(): Promise<void> {
    const usernames = await this.deps.getStreamers();
    this.roster = usernames;
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
      // Resolved after the state response is in hand, so an avatar lookup
      // can never widen the balance poll it rides along with. Failures are
      // swallowed here as well as inside AvatarCache: this must degrade to
      // monograms, never to a stale or errored snapshot.
      const avatars = this.deps.avatars
        ? await this.deps.avatars
            .resolve(data.streamers.map((s) => s.username))
            .catch(() => new Map<string, string | null>())
        : new Map<string, string | null>();

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

        const anchor = this.streamAnchor.get(s.username);
        const window = this.gainWindow(s.username, dayAgo);

        return {
          ...s,
          gained24h:
            window === null || typeof s.points !== "number"
              ? null
              : s.points - window.balance,
          gainedSince: window === null || typeof s.points !== "number" ? null : window.ts,
          gainedStream:
            anchor === undefined || typeof s.points !== "number"
              ? null
              : s.points - anchor,
          spark: downsample(this.deps.history.seriesSince(s.username, dayAgo), dayAgo, at),
          avatarUrl: avatars.get(normaliseUsername(s.username)) ?? null,
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
  ring(eventType: string, message: string | null = null): void {
    // Attributed against the roster resolved by the last refresh, so the
    // card can show "last: claim 4m ago" per streamer. An unattributable
    // line is stored with a null streamer, exactly as before.
    this.deps.history.recordEvent(
      eventType, this.now(), message, attribute(message, this.roster),
    );
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
