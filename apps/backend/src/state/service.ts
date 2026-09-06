import { EventEmitter } from "node:events";
import type { History } from "../db/history.js";
import { attribute } from "./attribute.js";
import { downsample } from "./gains.js";
import { clip, intersect, total } from "./spans.js";
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
  /**
   * When the current stream started, per Twitch itself; null when
   * offline. A timestamp rather than a duration so the card can tick it
   * client-side -- a server-sent duration would differ on every poll and
   * wake every SSE client with a frame nothing meaningful changed in.
   */
  liveSince: number | null;
  /** Identity of the current stream; the anchor key for gainedStream. */
  streamId: string | null;
  /** When this channel was last live; null while live or if never seen. */
  lastLive: number | null;
  /** The newest event attributed to this streamer, for the activity line. */
  lastActivity: { ts: number; type: string } | null;
  /**
   * Milliseconds the channel was live in the last 24h.
   *
   * Not shown on the card: for a single ongoing stream it is the same
   * fact as `liveSince` already renders as uptime, only clipped to the
   * window, so a channel up for 27 hours read "live 24h" beside its own
   * "1d 03h". Kept because the intersection below computes the spans
   * anyway, and a per-streamer view would want it.
   */
  online24h: number;
  /** Milliseconds online *and* mined in the last 24h, rounded to the minute. */
  mined24h: number;
  /** Milliseconds mined all-time, rounded to the minute. */
  minedTotal: number;
  /** Points per hour mined, or null below MIN_MINED_FOR_RATE_MS. */
  pointsPerHour: number | null;
}

/** What the Python helper reports, before this service derives the rest. */
export type RawStreamerState = Omit<
  StreamerState,
  | "gained24h" | "gainedSince" | "gainedStream" | "spark" | "avatarUrl"
  | "liveSince" | "lastLive" | "lastActivity"
  | "online24h" | "mined24h" | "minedTotal" | "pointsPerHour"
> & {
  /** Twitch's stream createdAt in epoch ms; null when offline. */
  streamStartedAt: number | null;
};

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/**
 * Mining time below which points-per-hour is not reported.
 *
 * A handful of points over six minutes extrapolates to a confident
 * four-digit rate that the next tick contradicts. The figure only means
 * something once the denominator is large enough to be stable.
 */
const MIN_MINED_FOR_RATE_MS = 15 * 60_000;

/**
 * Quantisation step for the duration figures.
 *
 * These are inherently time-dependent while a stream is live -- an open
 * span grows with the wall clock -- so they cannot be made perfectly
 * still without lying about them (an earlier attempt cut them off at the
 * stream's start, which under-reported mining time to zero). Instead
 * they are rounded down to a coarse step, so a poll changes the payload
 * at most once per step rather than on every tick.
 *
 * Five minutes is chosen against the poll interval (60s): at most one
 * SSE frame per five polls from this source, while the card's own
 * client-side clock carries the second-by-second detail.
 *
 * Rounded *down*, not to nearest: these are "time so far" figures, and
 * rounding up would claim mining that has not happened yet.
 */
const QUANTUM_MS = 5 * 60_000;
const quantise = (ms: number) => Math.floor(ms / QUANTUM_MS) * QUANTUM_MS;

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
      // Rides the existing poll rather than its own timer: this is exactly
      // the cadence the heartbeat needs, and a second timebase would be
      // one more thing to reconcile when the two disagree.
      this.deps.history.beatMinerSession(at);
      this.lastError = null;
      const dayAgo = at - DAY_MS;

      this.streamers = data.streamers.map((s) => {
        if (typeof s.points === "number") {
          this.deps.history.recordPoints(s.username, s.points, at);
        }

        // An upsert on Twitch's stream id rather than a reaction to an
        // observed transition: this runs on every live tick, so a restart
        // mid-stream finds the existing row and keeps its anchor intact.
        if (s.isOnline && s.streamId !== null && s.streamStartedAt !== null) {
          this.deps.history.openStreamerSession(
            s.username,
            s.streamId,
            s.streamStartedAt,
            typeof s.points === "number" ? s.points : null,
          );
        }
        // Any other open session for this streamer has ended. Clamped
        // inside History to our last snapshot, so an outage is not billed
        // as online time.
        this.deps.history.closeStreamerSessionsExcept(s.username, s.streamId, at);

        const anchor = s.streamId === null
          ? null
          : this.deps.history.streamAnchor(s.username, s.streamId);
        const window = this.gainWindow(s.username, dayAgo);
        const gained24h =
          window === null || typeof s.points !== "number"
            ? null
            : s.points - window.balance;

        // Measured all the way to `at`, including the stream and miner
        // session still running.
        //
        // These figures must never be completed by the client. Mining
        // time is the *intersection* of "channel live" and "miner up",
        // and only this side knows the second half -- a card that added
        // the running stream's own elapsed time would be assuming the
        // miner was up for all of it, which is precisely the conflation
        // the two clocks exist to prevent. A miner started ten minutes
        // into a day-long stream reported a full day of mining.
        //
        // The SSE cost of an ever-growing figure is handled by rounding
        // to the minute (toMinutes below): a live figure then changes at
        // most once a minute rather than on every poll.
        const online = clip(this.deps.history.streamerSpans(s.username, dayAgo), dayAgo, at);
        const mined24h = total(intersect(
          online,
          clip(this.deps.history.minerSpans(dayAgo), dayAgo, at),
        ));
        const minedTotal = total(intersect(
          clip(this.deps.history.streamerSpans(s.username), 0, at),
          clip(this.deps.history.minerSpans(), 0, at),
        ));

        return {
          ...s,
          gained24h,
          gainedSince: window === null || typeof s.points !== "number" ? null : window.ts,
          gainedStream:
            anchor === null || typeof s.points !== "number" ? null : s.points - anchor,
          spark: downsample(this.deps.history.seriesSince(s.username, dayAgo), dayAgo, at),
          avatarUrl: avatars.get(normaliseUsername(s.username)) ?? null,
          liveSince: s.streamStartedAt,
          lastLive: this.deps.history.lastLive(s.username),
          lastActivity: this.deps.history.lastActivity(s.username),
          online24h: quantise(total(online)),
          mined24h: quantise(mined24h),
          minedTotal: quantise(minedTotal),
          pointsPerHour:
            mined24h < MIN_MINED_FOR_RATE_MS || gained24h === null
              ? null
              : Math.round((gained24h / (mined24h / HOUR_MS)) * 10) / 10,
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
    const ts = this.now();
    this.deps.history.recordEvent(
      eventType, ts, message, attribute(message, this.roster),
    );
    // Pushed straight to connected clients, in the row shape /api/events
    // serves. Emitted per ring rather than alongside the debounced
    // "change": a burst coalesces into one refresh, but each ring is its
    // own feed row and dropping any would leave a hole in the log.
    this.emit("event", { ts, type: eventType, message });
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
