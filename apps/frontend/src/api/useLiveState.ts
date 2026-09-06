import { useCallback, useEffect, useState } from "react";
import { api, UnauthorizedError } from "./client.js";

export interface StreamerState {
  username: string;
  displayName: string | null;
  channelId: string | null;
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
  lastActivity: { ts: number; type: string } | null;
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
}

export interface StateSnapshot {
  streamers: StreamerState[];
  lastUpdated: number | null;
  stale: boolean;
  error: string | null;
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

export function useLiveState() {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  // Bumped to tear down a stream that gave up and build a fresh one --
  // the only way back after `authExpired`, since that state stops the
  // reconnect loop for good.
  const [attempt, setAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The session cookie is gone, so reconnecting is pointless -- the app has
  // to send the user back through the login gate.
  const [authExpired, setAuthExpired] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get<StateSnapshot>("/api/streamers")
      .then((s) => { if (alive) setSnapshot(s); })
      .catch((cause) => {
        // Surface the failure instead of leaving a blank dashboard with
        // no explanation -- mirrors Streamers.tsx's initial-load handling.
        if (alive) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });

    let source: EventSource | null = null;
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
      source = new EventSource("/api/stream");

      source.addEventListener("open", () => {
        if (!alive) return;
        clearGrace();
        setConnected(true);
      });

      source.addEventListener("state", (event) => {
        try {
          setSnapshot(JSON.parse((event as MessageEvent).data) as StateSnapshot);
        } catch {
          // A malformed frame must never take the page down.
        }
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
            source?.close();
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
      source?.close();
    };
  }, [attempt]);

  /**
   * Resume after `authExpired`, once a new session has been established.
   *
   * Without this the hook stays parked: it deliberately stops reconnecting
   * against a dead cookie, so a user who logs back in on the same page gets
   * a dashboard with no live updates until they refresh by hand.
   */
  const retry = useCallback(() => {
    setAuthExpired(false);
    setAttempt((n) => n + 1);
  }, []);

  return { snapshot, connected, loadError, authExpired, retry };
}
