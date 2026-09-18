import {
  createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useRef,
  useState,
} from "react";
import { api, UnauthorizedError } from "./client.js";

export interface StreamerState {
  username: string;
  displayName: string | null;
  channelId: string | null;
  /**
   * The drop campaign whose subscription put this channel in the roster,
   * or null for one the user added by hand.
   *
   * Optional like the other late additions here: a snapshot from a
   * backend that predates the field has no such key, and StreamerMeta
   * reads it defensively for that reason.
   */
  ownedByLabel?: string | null;
  points: number | null;
  isOnline: boolean | null;
  pointsEnabled: boolean | null;
  error?: string;
  gained24h: number | null;
  /** Window start when it is shorter than 24h; null when the window is full. */
  gainedSince: number | null;
  gainedStream: number | null;
  spark: number[];
  avatarUrl: string | null;
  /**
   * When the current stream started, per Twitch; null when offline.
   * A timestamp, not a duration: the card ticks it client-side, so the
   * server never has to resend a number that changes every second.
   */
  liveSince: number | null;
  streamId: string | null;
  /** When this channel was last live; null while live or if never seen. */
  lastLive: number | null;
  /**
   * The newest event attributed to this streamer. `message` is the miner's
   * own log line, absent on rows stored before the doorbell forwarded one.
   * Lossy display text -- see parseActivity, which reads only its exact parts.
   */
  lastActivity: { ts: number; type: string; message?: string | null } | null;
  /**
   * Milliseconds live in the last 24h. Deliberately not rendered: the
   * uptime from `liveSince` already answers "how long has this channel
   * been live", and clipping it to the window made it read "live 24h"
   * beside a 27-hour uptime.
   */
  online24h: number;
  /** Milliseconds mined -- live AND the miner up -- in the last 24h. */
  mined24h: number;
  minedTotal: number;
  pointsPerHour: number | null;
  /**
   * Combined factor of every active channel-points multiplier, or null
   * when there is none. Optional: a snapshot from a backend that
   * predates the field has no such key -- see StreamerMeta, which
   * reads all four defensively.
   *
   * NOT a subscription flag, though a sub is the usual way to get one:
   * upstream's own `is_subscribed` is exactly "has any active
   * multiplier", and multipliers have other sources. The card reports
   * the factor rather than inferring a sub from it.
   */
  multiplier?: number | null;
  /** A points bonus is sitting unclaimed on this channel right now. */
  claimPending?: boolean;
  /**
   * Whether the miner is observed to be watching this channel, from
   * watch-point gains. Already derived by the backend for the config
   * rows; the dashboard card shows the same fact.
   */
  watching?: boolean;
  /**
   * The channel's active community goal, or null when it has none.
   * Kept behind a disclosure on the card -- see StreamerMeta.
   */
  goal?: { title: string; contributed: number; needed: number } | null;
  /** The channel's category, or null when none is set. */
  game?: string | null;
  /**
   * The stream's title. Shown only in the context popover, never inline:
   * titles run long and change mid-stream, so the card would truncate it
   * to noise.
   */
  streamTitle?: string | null;
  /**
   * Current viewers, already rounded to three significant figures by the
   * backend, or null when the channel is offline.
   */
  viewers?: number | null;
  /**
   * The next drop this channel has still to earn, or null when it has
   * none. Also null when the miner is not claiming drops for the
   * channel -- we have not looked, rather than found nothing, so the
   * card shows no badge either way.
   */
  drop?: {
    name: string;
    minutes: number;
    required: number;
    /** Minutes met and waiting to be collected, not merely in progress. */
    claimable: boolean;
    /** What the drop awards; empty when the miner did not report any. */
    benefits: string[];
    /** Campaign deadline in epoch ms, or null when unknown. */
    endsAt: number | null;
  } | null;
}

export interface StateSnapshot {
  streamers: StreamerState[];
  lastUpdated: number | null;
  stale: boolean;
  error: string | null;
  /**
   * This snapshot was built from the backend's database alone and a
   * Twitch pass is now running to complete it.
   *
   * Everything stored is real -- names, cached avatars, balances, 24h
   * gains, sparklines, mining totals. What only Twitch can answer is
   * null: `isOnline`, `viewers`, `game`, `streamTitle`, `drop`. Liveness
   * in particular is deliberately null rather than guessed from the last
   * poll, which may be hours stale, so "Live now" is empty rather than
   * wrong until the pass lands.
   *
   * Only ever true on the initial fetch, after a cold start or a stretch
   * with nobody connected. Absent on SSE frames, which are complete.
   */
  pending?: boolean;
}

/**
 * How long a dropped stream must stay down before the header badge says so.
 *
 * EventSource reconnects on its own within a few seconds, so a shorter-lived
 * drop is invisible to the user in every way except the badge -- reporting it
 * trains people to ignore the indicator.
 */
export const DISCONNECT_GRACE_MS = 5_000;

/** Delay before rebuilding a stream that failed to open. */
export const RECONNECT_DELAY_MS = 3_000;

/** A handler for one kind of stream frame, handed the frame's parsed JSON. */
type FrameHandler = (data: unknown) => void;

type Handlers = Map<string, Set<FrameHandler>>;

/** An open EventSource and the frame types already listened for on it. */
interface Wiring {
  source: EventSource;
  wired: Set<string>;
}

/**
 * Listens for `type` on the source, fanning each frame out to that type's
 * handlers. Once per type per source: a second listener would deliver every
 * frame twice.
 */
function wire(wiring: Wiring, handlers: Handlers, type: string) {
  if (wiring.wired.has(type)) return;
  wiring.wired.add(type);
  wiring.source.addEventListener(type, (frame) => {
    let data: unknown;
    try {
      data = JSON.parse((frame as MessageEvent).data);
    } catch {
      // A malformed frame must never take the page down.
      return;
    }
    // Copied, since a handler may unsubscribe while the set is being walked.
    for (const handler of [...(handlers.get(type) ?? [])]) handler(data);
  });
}

export interface LiveState {
  snapshot: StateSnapshot | null;
  connected: boolean;
  loadError: string | null;
  /**
   * The session cookie is gone, so reconnecting is pointless -- the app has
   * to send the user back through the login gate. Final for this provider:
   * the gate unmounts it, and the next unlock mounts a fresh one.
   */
  authExpired: boolean;
  /**
   * Adds a handler for one frame type and returns its removal. Handlers
   * outlive a reconnect: every rebuilt source is wired to them.
   */
  subscribe: (type: string, handler: FrameHandler) => () => void;
}

const LiveStateContext = createContext<LiveState | null>(null);

/**
 * Owns the app's one connection to /api/stream.
 *
 * Every EventSource holds a connection open for the life of the page, and
 * HTTP/1.1 allows a browser six per host across all its tabs -- so
 * everything that wants a frame subscribes here rather than opening its own.
 */
export function LiveStateProvider({ children }: { children: ReactNode }) {
  return createElement(LiveStateContext.Provider, { value: useLiveConnection() }, children);
}

/** The shared stream. Throws outside a LiveStateProvider. */
export function useLiveState(): LiveState {
  const live = useContext(LiveStateContext);
  if (live === null) throw new Error("useLiveState needs a LiveStateProvider above it");
  return live;
}

/**
 * Calls `handler` with each `type` frame on the shared stream while
 * `enabled`. Always the latest handler, so an inline function does not
 * resubscribe on every render.
 */
export function useStreamEvent<T>(type: string, handler: (data: T) => void, enabled = true) {
  const { subscribe } = useLiveState();
  const latest = useRef(handler);
  // Declared before the subscribing effect, so it has run by the time that
  // one does.
  useEffect(() => { latest.current = handler; });
  useEffect(() => {
    if (!enabled) return;
    return subscribe(type, (data) => latest.current(data as T));
  }, [type, enabled, subscribe]);
}

function useLiveConnection(): LiveState {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const handlers = useRef<Handlers>(new Map());
  const current = useRef<Wiring | null>(null);

  const subscribe = useCallback((type: string, handler: FrameHandler) => {
    let set = handlers.current.get(type);
    if (set === undefined) {
      set = new Set();
      handlers.current.set(type, set);
    }
    set.add(handler);
    // Children subscribe before this provider's own effect has opened a
    // source; connect() wires those once it does.
    if (current.current !== null) wire(current.current, handlers.current, type);
    return () => { set.delete(handler); };
  }, []);

  useEffect(() => {
    let alive = true;
    const unsubscribeState = subscribe("state", (data) => setSnapshot(data as StateSnapshot));
    api.get<StateSnapshot>("/api/streamers")
      // Adopted even when pending. A pending snapshot is built from the
      // backend's own database -- names, cached avatars, balances, gains
      // and sparklines are all real; only what Twitch alone can answer
      // (liveness above all) is still null. Rendering it beats holding
      // the skeleton for the seconds the state pass takes, and the SSE
      // frame that pass emits replaces it in place.
      .then((s) => { if (alive) setSnapshot(s); })
      .catch((cause) => {
        // Surface the failure instead of leaving a blank dashboard with
        // no explanation -- mirrors Streamers.tsx's initial-load handling.
        if (alive) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });

    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const clearGrace = () => {
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    /**
     * Distinguishes "session expired" from "backend briefly unreachable".
     *
     * EventSource cannot report a status code -- a 401 and a dropped socket
     * both surface as a bare "error" event -- so the only way to tell them
     * apart is to ask an authenticated endpoint directly.
     */
    const probeAuth = async (): Promise<boolean> => {
      try {
        await api.get("/api/status");
        return true;
      } catch (cause) {
        if (cause instanceof UnauthorizedError) return false;
        // Any other failure (backend down, network blip) is not an auth
        // problem, so reconnecting is still the right move.
        return true;
      }
    };

    const connect = () => {
      if (!alive) return;
      const source = new EventSource("/api/stream");
      current.current = { source, wired: new Set() };
      for (const type of handlers.current.keys()) wire(current.current, handlers.current, type);

      source.addEventListener("open", () => {
        if (!alive) return;
        clearGrace();
        setConnected(true);
      });

      source.addEventListener("error", () => {
        if (!alive) return;

        // Only report a drop that outlasts the grace window: a transport
        // blip that recovers inside it is invisible to the user otherwise.
        if (graceTimer === null) {
          graceTimer = setTimeout(() => {
            graceTimer = null;
            if (alive) setConnected(false);
          }, DISCONNECT_GRACE_MS);
        }

        // EventSource retries transport failures itself but gives up
        // permanently on an HTTP error response -- which is exactly what a
        // restarted backend serves, since sessions live in an in-memory Map
        // and every existing cookie becomes unknown. Rebuild the source
        // ourselves rather than leaving the page silently dead until a
        // manual refresh.
        if (reconnectTimer !== null) return;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (!alive) return;
          void probeAuth().then((authed) => {
            if (!alive) return;
            if (!authed) {
              // Retrying against a dead cookie would 401 forever.
              setAuthExpired(true);
              setConnected(false);
              clearGrace();
              return;
            }
            current.current?.source.close();
            connect();
          });
        }, RECONNECT_DELAY_MS);
      });
    };

    connect();

    return () => {
      alive = false;
      clearGrace();
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      current.current?.source.close();
      current.current = null;
      unsubscribeState();
    };
  }, [subscribe]);

  return { snapshot, connected, loadError, authExpired, subscribe };
}
