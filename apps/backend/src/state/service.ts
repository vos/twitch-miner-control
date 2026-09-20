import { EventEmitter } from "node:events";
import type { History } from "../db/history.js";
import type { Streamers } from "../db/streamers.js";
import { attribute } from "./attribute.js";
import { downsample, gainWindow } from "./gains.js";
import { clip, intersect, total } from "./spans.js";
import { normaliseUsername } from "./roster.js";
import type { ProfileRowData } from "./profiles.js";
import type { DropProgress, DropsTarget } from "./drops.js";
import { roundViewers } from "./viewers.js";

export interface StreamerState {
  username: string;
  channelId: string | null;
  /**
   * The drop campaign whose subscription put this channel in the roster,
   * or null when nobody did -- a hand-added streamer, a followed one, or
   * a backend wired without the lookup.
   *
   * The subscription's cached label rather than its id: the dashboard
   * wants to render "where did this come from" without a second fetch,
   * and that label is stored precisely so it still reads correctly once
   * the campaign ends and leaves the catalogue.
   */
  ownedByLabel: string | null;
  /**
   * The game that campaign is for, or null when it is not known.
   *
   * Carried beside the label rather than replacing it because they
   * answer different questions: the game is what a viewer recognises
   * and what the card shows, while the label identifies the specific
   * campaign and is what the tooltip names. Campaign names are mostly
   * unrecognisable on their own ("DF Streamer Ladder FINNAL" is Delta
   * Force), which is why the game leads.
   *
   * Null when the campaign has left the catalogue or never carried a
   * game -- the card falls back to the label, since a guess would be
   * worse than none.
   */
  ownedByGame: string | null;
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
  /**
   * The newest event attributed to this streamer, for the activity line.
   *
   * `message` is the miner's own formatted line. It is display text and
   * lossy by construction -- balances inside it are millified -- so the
   * card reads only the exact parts (the points earned, the reason) and
   * never the balance. See `python/helpers/doorbell.py`.
   */
  lastActivity: { ts: number; type: string; message: string | null } | null;
  /**
   * Whether the miner appears to be watching this channel right now.
   *
   * Observed, not predicted. The miner watches two channels at a time and
   * picks them itself -- filtering to live, points-enabled, un-banned
   * channels and then applying a priority chain in which the configured
   * order is only the last tiebreak, so a streamer with a pending watch
   * streak or a claimable drop can take a slot ahead of the top two. None
   * of that selection is published: it lives in the `run.py` process,
   * while this service talks to a separate state helper.
   *
   * So this is inferred from the one thing that does cross over: a
   * `GAIN_FOR_WATCH` event, which Twitch sends only for a channel we are
   * actually watching. True when one arrived within WATCH_GAIN_TTL_MS.
   *
   * The cost of inferring it is latency at both edges -- it lags the first
   * gain of a new slot and lingers briefly after a slot is dropped -- which
   * is the honest trade for never claiming a channel is being mined when
   * it is not.
   */
  watching: boolean;
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
  /**
   * Combined factor of the channel's active points multipliers, or null
   * when there is none. Not a subscription flag -- see _multiplier in
   * helpers/state.py for why the factor is reported instead.
   */
  multiplier: number | null;
  /** A points bonus is sitting unclaimed on this channel. */
  claimPending: boolean;
  /** The channel's active community goal, or null when it has none. */
  goal: { title: string; contributed: number; needed: number } | null;
  /**
   * The next drop this channel has still to earn, or null when it has
   * none -- including when the miner is not claiming drops for it, in
   * which case we have not looked rather than found nothing.
   */
  drop: {
    name: string;
    minutes: number;
    required: number;
    claimable: boolean;
    benefits: string[];
    endsAt: number | null;
  } | null;
  /** The channel's category, or null when it has none set. */
  game: string | null;
  /**
   * The stream's title. Not rendered on the card itself -- it is long,
   * emoji-laden and changes mid-stream -- but carried for the popover.
   */
  streamTitle: string | null;
  /**
   * Current viewers, rounded to three significant figures, or null when
   * the channel is offline. Rounded because the snapshot comparison that
   * gates SSE frames is a whole-object compare: an exact count moves
   * every poll and would wake every browser for nothing.
   */
  viewers: number | null;
}

/** What the Python helper reports, before this service derives the rest. */
export type RawStreamerState = Omit<
  StreamerState,
  | "gained24h" | "gainedSince" | "gainedStream" | "spark" | "avatarUrl"
  | "liveSince" | "lastLive" | "lastActivity" | "watching"
  | "online24h" | "mined24h" | "minedTotal" | "pointsPerHour"
  | "game" | "streamTitle" | "viewers" | "drop" | "ownedByLabel"
  | "ownedByGame"
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
 * How long a `GAIN_FOR_WATCH` keeps `watching` true.
 *
 * Twitch drips watch points roughly every five minutes, so the window has
 * to clear that comfortably or the badge would blink off between two
 * gains from a channel that never stopped being watched. Ten minutes is
 * two missed drips: long enough to ride out a slow one, short enough that
 * a dropped slot stops claiming to be mined within a minute or two of the
 * next refresh. The miner's own WATCH_SESSION priority uses seven minutes
 * for a related judgement (vendor StreamerSelector.py).
 */
const WATCH_GAIN_TTL_MS = 10 * 60_000;

/**
 * How old the miner's last liveness verdict may be and still be used.
 *
 * The miner announces every channel's state within about a second of
 * starting and then reports transitions as they happen, so while it is
 * running its verdict is current to the minute. It is only the *stopped*
 * case that needs bounding: nothing retracts the last verdict when the
 * miner exits, so a row can sit at "Online!" indefinitely. The dev
 * database held ten-day-old ONLINE rows for two channels that had since
 * left the roster entirely -- rendering those as live would be precisely
 * the false claim the local frame exists to avoid.
 *
 * Fifteen minutes is comfortably longer than any gap between miner
 * reports while it is up, and short enough that a stopped miner's last
 * word expires before anyone would still believe it. Past that the field
 * goes back to null -- unknown, not offline.
 */
const LIVENESS_TRUST_MS = 15 * 60_000;

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

/**
 * Who a subscription-owned channel came from: the campaign's own label,
 * and the game it is for when the catalogue still knows one.
 *
 * One lookup returning both rather than two: the caller resolves the
 * subscription once, and the game is read off the same campaign.
 */
export interface OwnerLabel {
  label: string;
  game: string | null;
}

/** The two owner fields from one lookup, both null when unowned. */
function ownerFields(
  owner: OwnerLabel | null,
): { ownedByLabel: string | null; ownedByGame: string | null } {
  return {
    ownedByLabel: owner?.label ?? null,
    ownedByGame: owner?.game ?? null,
  };
}

export interface StateServiceDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
  history: History;
  /**
   * Per-streamer sightings, the floor under every mining figure.
   *
   * Optional so a boot before the store exists -- and the many tests that
   * do not care -- still run. Absent, mining time falls back to the two
   * older clocks, which is exactly the behaviour that over-reported a
   * channel added mid-stream.
   */
  streamers?: Streamers;
  getStreamers: () => string[] | Promise<string[]>;
  /**
   * Which subscription owns a channel, by its cached label.
   *
   * Deliberately a lookup beside the roster rather than a widening of
   * `getStreamers`: that resolver unions the config list with the follow
   * list and dedupes the two (see state/roster.ts), and threading a
   * second field through it would complicate the one piece of roster
   * logic that has to stay simple. Read per call, like the rest of this
   * service's config access, so a subscription added between passes is
   * picked up without a restart.
   *
   * Optional, and absent means every channel reports a null label --
   * which is what every caller that does not care already gets.
   */
  ownerLabel?: (username: string) => OwnerLabel | null;
  intervalMs?: number;
  debounceMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  /**
   * Optional so tests (and a boot before the cache exists) can run
   * without one. Absent, every streamer simply reports a null avatar.
   */
  profiles?: {
    resolve(
      logins: string[],
      live: ReadonlySet<string>,
    ): Promise<Map<string, ProfileRowData>>;
  };
  /**
   * Drop progress, on its own slow clock. Absent, every streamer simply
   * reports a null drop.
   */
  drops?: {
    resolve(targets: DropsTarget[]): Promise<Map<string, DropProgress>>;
  };
  /**
   * Whether anyone is currently watching the dashboard.
   *
   * This process spends most of its life running the miner with no
   * browser attached -- days at a time -- and everything a refresh
   * derives for display is thrown away unread in that state. When this
   * returns false, a refresh still performs every write that feeds a
   * stored figure (see doRefresh) and then stops, skipping the profile
   * and drops round trips, the per-streamer derivation, and the SSE
   * frame nobody is listening for.
   *
   * Nothing is lost by it: the rendered fields are computed from the
   * history the idle path keeps writing, so the first refresh after a
   * client connects rebuilds them in full, however long the gap was.
   *
   * Optional, and absent means "always connected" -- every existing
   * caller and test then behaves exactly as before.
   */
  clientsConnected?: () => boolean;
}

export class StateService extends EventEmitter {
  private streamers: StreamerState[] = [];
  private lastUpdated: number | null = null;
  private lastError: string | null = null;
  /**
   * Whether the last refresh failed because the Twitch session is dead.
   *
   * Tracked separately from `lastError` because an AUTH failure
   * deliberately reports no error text -- the dashboard's sign-in notice
   * says it better -- and staleness must not be inferred from the absence
   * of that text, or a session that dies moments after a good refresh
   * reads as freshly updated.
   */
  private sessionDead = false;
  /**
   * Counts calls to clearError(). doRefresh() samples it before its round
   * trip and compares afterwards: a request that was already in flight when
   * a login cleared the error belongs to the previous, signed-out session,
   * so its failure must not be written back over the clean state.
   */
  private errorEpoch = 0;
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
  /**
   * Whether `this.streamers` is missing the fields a dashboard renders.
   *
   * Set when a refresh takes the idle path, which stops before deriving
   * gains, sparklines, avatars and drops. Distinct from `stale`: a
   * snapshot can be perfectly current and still be undrawable, which is
   * exactly the state this process sits in while nobody is watching.
   *
   * Starts true: until the first full pass lands there is nothing to
   * draw, and the empty array is "we have not looked yet", not "this
   * user follows nobody". Serving that as a finished answer let the
   * dashboard leave its skeleton and render a complete-looking empty
   * page for the whole of a cold start.
   */
  private undrawn = true;

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
      stale: this.lastError !== null || this.sessionDead || age > staleAfter,
      error: this.lastError,
    };
  }

  /**
   * Whether the held snapshot still needs its display fields derived.
   *
   * True before the first full pass and after any idle one, i.e. exactly
   * when the held copy would render as blank cards. /api/streamers passes
   * it to the client as `pending` so the dashboard keeps its loading
   * skeleton, and kicks a refresh whose SSE frame carries the real data.
   */
  get needsDerive(): boolean {
    return this.undrawn;
  }

  /**
   * Drops a refresh error that a just-completed login has made obsolete.
   *
   * A refresh already in flight when the user signs in is answered by the
   * *old*, signed-out helper, so its 401 lands after the login succeeded.
   * state.py cannot classify that one as AUTH -- by the time it re-checks,
   * the new cookie pickle is on disk and the session reads as healthy -- so
   * it arrives as an ordinary GQL failure and its raw traceback is shown on
   * the dashboard until some later refresh happens to succeed.
   *
   * Only the error text is cleared. `lastUpdated` and the roster are left
   * alone: the numbers really are as old as the last good refresh, and the
   * recycle that follows a login issues a fresh one anyway.
   */
  clearError(): void {
    // Bumped even when there is nothing to clear: a request already in
    // flight must still be disowned, or its failure lands on the fresh
    // session moments later.
    this.errorEpoch += 1;
    if (this.lastError === null && !this.sessionDead) return;
    this.lastError = null;
    this.sessionDead = false;
    this.emit("change", this.snapshot());
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
      // A resolved empty roster *is* the finished answer: there is
      // nothing to derive, so the dashboard should render its empty
      // state immediately rather than waiting on a refresh that would
      // return this same emptiness.
      this.undrawn = false;
      this.lastUpdated = this.now();
      this.lastError = null;
      this.sessionDead = false;
      if (hadStreamers) {
        this.emit("change", this.snapshot());
      }
      return;
    }
    const epoch = this.errorEpoch;

    // Nothing drawable is being held -- a cold start, or the first pass
    // after a stretch with nobody watching. Paint from the database now
    // rather than making the dashboard wait out state.py's per-streamer
    // GQL loop for figures it mostly already has. Only the *first* such
    // pass does this; once the live pass below lands, `undrawn` is false
    // and a client holding real cards is never sent backwards.
    //
    // A refresh reaching here on its own (the 60s tick, a doorbell ring)
    // paints too, so an idle backend that wakes without an HTTP request
    // still has cards ready for whoever connects next.
    if (this.deps.clientsConnected?.() !== false) this.paintFrom(usernames);

    try {
      const data = await this.deps.client.request<{ streamers: RawStreamerState[] }>(
        "state", { streamers: usernames },
      );
      const before = JSON.stringify(this.streamers);
      const previous = new Map(this.streamers.map((s) => [s.username, s]));
      const at = this.now();
      this.lastUpdated = at;
      // Rides the existing poll rather than its own timer: this is exactly
      // the cadence the heartbeat needs, and a second timebase would be
      // one more thing to reconcile when the two disagree.
      this.deps.history.beatMinerSession(at);
      this.lastError = null;
      this.sessionDead = false;
      const dayAgo = at - DAY_MS;

      // Every write that outlives this pass happens here, before the
      // idle check below, and never depends on a profile or drop. The
      // clamp inside closeStreamerSessionsExcept reads the point
      // snapshot recorded alongside it, so the two must stay in the same
      // loop on the same clock -- splitting them would let an idle pass
      // close a session against a balance it had not written yet.
      for (const s of data.streamers) {
        if (typeof s.points === "number") {
          this.deps.history.recordPoints(s.username, s.points, at);
        }

        // Every polled channel, live or not: the floor is "since when
        // have we been looking", which a channel answers by being in the
        // roster at all, not by being live. The display name rides along
        // so a poll that could not resolve one keeps the last we saw
        // rather than falling back to the lowercase login.
        this.deps.streamers?.see(s.username, at, s.displayName);

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
      }

      // Nobody is watching: the stored record above is complete and
      // everything below this line exists only to be rendered. Bail
      // before spending two GQL round trips and a full derivation on a
      // snapshot no one will read.
      //
      // `this.streamers` is deliberately left as it was rather than
      // cleared -- snapshot() reports it alongside lastUpdated, and a
      // client that connects between this return and the refresh it
      // triggers should see the last real numbers, stale-flagged, not an
      // empty dashboard.
      if (this.deps.clientsConnected && !this.deps.clientsConnected()) {
        // Only the *first* idle pass changes anything: from here on the
        // held copy keeps whatever it last derived, now going stale.
        this.undrawn = true;
        return;
      }

      // Resolved after the state response is in hand, so a profile lookup
      // can never widen the balance poll it rides along with. Failures are
      // swallowed here as well as inside ProfileCache: this must degrade
      // to monograms, never to a stale or errored snapshot.
      //
      // The live set drives which channels get their volatile fields
      // refreshed: an offline channel has no viewer count to go stale, so
      // refreshing it would spend a GQL call on nothing.
      const liveNow = new Set(
        data.streamers
          .filter((s) => s.isOnline === true)
          .map((s) => normaliseUsername(s.username)),
      );
      const profiles = this.deps.profiles
        ? await this.deps.profiles
            .resolve(data.streamers.map((s) => s.username), liveNow)
            .catch(() => new Map<string, ProfileRowData>())
        : new Map<string, ProfileRowData>();

      // Live channels only: a drop accrues from watch time, so an offline
      // channel has nothing moving. The cache holds its own 10-minute
      // clock, so this is a cheap call on most passes.
      const drops = this.deps.drops
        ? await this.deps.drops
            .resolve(data.streamers
              .filter((s) => s.isOnline === true)
              .map((s) => ({ username: s.username, channelId: s.channelId })))
            .catch(() => new Map<string, DropProgress>())
        : new Map<string, DropProgress>();

      this.streamers = data.streamers.map(
        (s) => this.deriveOne(s, at, dayAgo, profiles, drops),
      );

      this.undrawn = false;

      if (before !== JSON.stringify(this.streamers)) {
        this.emit("change", this.snapshot());
      }
    } catch (cause) {
      return this.handleRefreshError(cause, epoch);
    }
  }

  /**
   * Builds one dashboard card from a raw state row plus stored history.
   *
   * Shared by the live pass and deriveLocal(), which differ only in where
   * the raw row comes from -- the helper, or the database. Keeping one
   * implementation is what stops the mining-time intersection being
   * written twice; see the comment on `mined24h` for why a second version
   * of that arithmetic would be a bug waiting to happen.
   */
  private deriveOne(
    s: RawStreamerState,
    at: number,
    dayAgo: number,
    profiles: Map<string, ProfileRowData>,
    drops: Map<string, DropProgress>,
  ): StreamerState {
    const anchor = s.streamId === null
      ? null
      : this.deps.history.streamAnchor(s.username, s.streamId);
    const window = gainWindow(this.deps.history, s.username, dayAgo, this.now());
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
    // The third clock. streamer_sessions.start_ts is Twitch's own
    // createdAt, so a channel added to the roster mid-stream opens a
    // session back-dated to a start we were never present for --
    // and the miner, up the whole time, agrees. Both existing clocks
    // are right and the intersection is still wrong: only "when did
    // we first see this channel" rules out the hours before we
    // arrived. Recorded just above, so a first-ever poll floors at
    // `at` and reports zero rather than the stream's whole length.
    //
    // Null (no store, or a channel the state pass has never seen)
    // leaves the older behaviour untouched.
    const seen = this.deps.streamers?.firstSeen(s.username) ?? null;
    const floor = seen ?? 0;
    const mined24h = total(intersect(
      clip(online, floor, at),
      clip(this.deps.history.minerSpans(dayAgo), dayAgo, at),
    ));
    const minedTotal = total(intersect(
      clip(this.deps.history.streamerSpans(s.username), floor, at),
      clip(this.deps.history.minerSpans(), 0, at),
    ));

    const profile = profiles.get(normaliseUsername(s.username));
    const drop = drops.get(normaliseUsername(s.username)) ?? null;
    // Read after the persistence loop above wrote this poll's own
    // name, so a resolved poll reads back what it just stored and a
    // failed one reads the last good name instead. Null only when no
    // poll has ever resolved the channel, which is the card's own cue
    // to fall back to the login.
    const known = this.deps.streamers?.get([s.username]).get(s.username) ?? null;
    return {
      ...s,
      // Overrides the spread: `s.displayName` is null whenever the
      // channel's community block is missing, which would otherwise
      // visibly rename the card to its lowercase login until the
      // next good poll.
      displayName: s.displayName ?? known?.displayName ?? null,
      ...ownerFields(this.deps.ownerLabel?.(s.username) ?? null),
      gained24h,
      gainedSince: window === null || typeof s.points !== "number" ? null : window.ts,
      gainedStream:
        anchor === null || typeof s.points !== "number" ? null : s.points - anchor,
      spark: downsample(this.deps.history.seriesSince(s.username, dayAgo), dayAgo, at),
      avatarUrl: profile?.avatarUrl ?? null,
      drop,
      game: profile?.game ?? null,
      streamTitle: profile?.title ?? null,
      // Damped so a count that drifts every poll does not push an SSE
      // frame to every browser -- see roundViewers.
      viewers: roundViewers(profile?.viewers ?? null),
      liveSince: s.streamStartedAt,
      lastLive: this.deps.history.lastLive(s.username),
      lastActivity: this.deps.history.lastActivity(s.username),
      // An offline channel is never being watched, whatever the last
      // gain says: the guard keeps a stale event from outliving the
      // stream it came from when a channel drops inside the window.
      watching: (() => {
        if (s.isOnline !== true) return false;
        const gained = this.deps.history.lastWatchGain(s.username);
        return gained !== null && at - gained <= WATCH_GAIN_TTL_MS;
      })(),
      online24h: quantise(total(online)),
      mined24h: quantise(mined24h),
      minedTotal: quantise(minedTotal),
      pointsPerHour:
        mined24h < MIN_MINED_FOR_RATE_MS || gained24h === null
          ? null
          : Math.round((gained24h / (mined24h / HOUR_MS)) * 10) / 10,
    };
  }

  /**
   * Paints the held snapshot from the database, if it has nothing to draw.
   *
   * Synchronous by design. /api/streamers reads snapshot() in the same
   * tick it answers, so a paint that waited on doRefresh's first `await`
   * would arrive too late and the response would carry an empty roster --
   * exactly the blank dashboard this work exists to remove. Returns
   * whether it painted, so the caller knows a fuller frame is still
   * coming.
   */
  async paintLocal(): Promise<boolean> {
    if (!this.undrawn) return false;
    // Resolves the roster the caller does not have. Async only because
    // resolveRoster may fetch the follow list; the derivation itself is
    // pure SQLite, about two milliseconds for eight channels. A failure
    // is not worth reporting -- the live refresh that follows hits the
    // same problem and reports it properly.
    const roster = this.roster.length > 0
      ? this.roster
      : await Promise.resolve(this.deps.getStreamers()).catch(() => []);
    // Re-checked after the await: a live refresh may have landed while
    // the roster was resolving, and overwriting its real cards with
    // database-only ones would drop the dashboard back a step.
    if (!this.undrawn) return false;
    return this.paintFrom(roster);
  }

  /**
   * The paint itself, given a roster already in hand.
   *
   * Separate from paintLocal() so doRefresh can call it without an
   * await. An extra microtask there would delay the state request by one
   * turn, which the in-flight coalescing tests detect -- and more to the
   * point, the early paint must never hold up the call it exists to
   * cover for.
   */
  private paintFrom(roster: string[]): boolean {
    if (!this.undrawn || roster.length === 0) return false;
    this.streamers = this.deriveLocal(roster);
    this.emit("change", this.snapshot());
    return true;
  }

  /**
   * Builds the card set from the database alone, with no Twitch call.
   *
   * The dashboard's first paint. state.py issues one GQL call per
   * streamer, sequentially, so a cold start spends seconds confirming
   * figures that are already on disk -- the same eight cards build from
   * SQLite in about two milliseconds. This is emitted first and the live
   * pass replaces it when it lands.
   *
   * Everything Twitch alone can answer is left null, `isOnline` above
   * all. The database does know which sessions are open, but an open row
   * only means the channel was live at the *last* poll, which may be
   * hours old -- the dev database held open rows for three channels that
   * had since left the roster entirely. Reporting that as "live now"
   * would put cards under the dashboard's "Live now" heading and then
   * move them when the truth arrived. Null is the state the UI already
   * has for "we have not looked": StatusPill renders nothing for it
   * rather than claiming OFFLINE, which would be just as much of a
   * claim.
   */
  deriveLocal(usernames: string[]): StreamerState[] {
    const at = this.now();
    const dayAgo = at - DAY_MS;
    const known = this.deps.streamers?.get(usernames) ?? new Map();
    // Empty rather than a lookup: profiles and drops are network-only.
    // The avatar is the exception and comes off the streamers row below,
    // where it is cached with a 7-day TTL.
    const profiles = new Map<string, ProfileRowData>();
    const drops = new Map<string, DropProgress>();

    return usernames.map((username) => {
      const row = known.get(username) ?? null;
      const series = this.deps.history.seriesSince(username, 0);

      // The miner's own verdict, which lands seconds after it starts --
      // far ahead of the state pass. Used only while recent enough to
      // mean something: see LIVENESS_TRUST_MS. Null (no verdict, or a
      // stale one) leaves the field unknown, which the UI renders as no
      // claim at all rather than as OFFLINE.
      const verdict = this.deps.history.lastLiveness(username);
      const isOnline = verdict !== null && at - verdict.ts <= LIVENESS_TRUST_MS
        ? verdict.online
        : null;

      // Only for a channel the miner says is live *now*: an open session
      // row alone proves nothing, since it stays open when the backend
      // stops. Paired with a fresh ONLINE verdict it is the real start
      // time, which is what the card's uptime counts from.
      const openSince = isOnline === true
        ? this.deps.history.openStreamerSessionStart(username)
        : null;

      // The raw row the helper would have returned, answered from store.
      const local: RawStreamerState = {
        username,
        channelId: null,
        displayName: row?.displayName ?? null,
        points: series.at(-1)?.balance ?? null,
        isOnline,
        pointsEnabled: null,
        streamId: null,
        streamStartedAt: openSince,
        multiplier: null,
        claimPending: false,
        goal: null,
      };
      const card = this.deriveOne(local, at, dayAgo, profiles, drops);
      // deriveOne reads the avatar off the profile map, which is empty
      // here; the cached one lives on the streamers row.
      return { ...card, avatarUrl: row?.avatarUrl ?? null };
    });
  }

  /**
   * Handles a failed refresh. Split out of doRefresh only so the derive
   * loop above could become its own method; the logic is unchanged.
   */
  private handleRefreshError(cause: unknown, epoch: number): void {
    // A login (or anything else calling clearError) happened while this
      // request was open, so it was answered by the session that has since
      // been replaced. Reporting its failure would put a stale traceback on
      // a dashboard that has just been signed in.
      if (epoch !== this.errorEpoch) return;
      // `code: "AUTH"` is state.py's verdict that it reloaded the cookie
      // pickle and still could not authenticate, i.e. the Twitch session is
      // dead rather than the request flaky. Re-emitted as its own event so
      // the HTTP layer can turn it into a visible "sign in again" prompt;
      // duck-typed on `code` rather than `instanceof NdjsonError` so a
      // stubbed client in a test can raise one without importing the
      // helper transport.
      if ((cause as { code?: unknown } | null)?.code === "AUTH") {
        this.emit("auth-error", cause);
        // A dead session is reported by the dashboard's own "Twitch
        // sign-in needed" notice, so the helper's raw GQL traceback would
        // only repeat it -- illegibly -- in the error alert beside it.
        this.lastError = null;
        this.sessionDead = true;
        // The roster goes with it. These points were read against a
        // session that no longer exists, no refresh can correct them, and
        // leaving the cards up shows numbers nothing will ever update
        // next to a notice saying we are signed out. lastUpdated is left
        // alone, so snapshot() still reports the result as stale.
        this.streamers = [];
      } else {
        // Anything else may well succeed on the next tick, so keep both
        // the message and the last known numbers; snapshot() reports them
        // as stale either way.
      this.lastError = cause instanceof Error ? cause.message : String(cause);
      this.sessionDead = false;
    }
    this.emit("change", this.snapshot());
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

  /**
   * Arms the poll and issues the first refresh.
   *
   * Returns that refresh so a caller who needs to know when the boot pass
   * has settled can await it -- index.ts holds its "derive even though
   * nobody is connected" flag open until then. Ignoring the return keeps
   * the original fire-and-forget behaviour: doRefresh() never rejects, and
   * start() must not block boot on a Twitch round trip.
   */
  start(): Promise<void> {
    // Already running: there is no new boot pass to report, and the
    // caller must not be handed a promise for one that settled long ago.
    if (this.ticker) return Promise.resolve();
    this.ticker = setInterval(() => void this.refresh(), this.deps.intervalMs ?? 60_000);
    // Arming the interval alone left the first tick a full period away, so
    // for 60s after every restart the dashboard rendered a confident total
    // of 0 built from no data at all. Kick one refresh immediately so the
    // snapshot is either real or explicitly "never updated" -- never a
    // fabricated zero.
    return this.refresh();
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
