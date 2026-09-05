import { useEffect, useState } from "react";
import { api } from "./client.js";

export interface StreamerState {
  username: string;
  displayName: string | null;
  channelId: string | null;
  points: number | null;
  isOnline: boolean | null;
  pointsEnabled: boolean | null;
  error?: string;
  gained24h: number | null;
  gainedStream: number | null;
  spark: number[];
}

export interface StateSnapshot {
  streamers: StreamerState[];
  lastUpdated: number | null;
  stale: boolean;
  error: string | null;
}

export function useLiveState() {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.get<StateSnapshot>("/api/streamers")
      .then((s) => { if (alive) setSnapshot(s); })
      .catch((cause) => {
        // Surface the failure instead of leaving a blank dashboard with
        // no explanation -- mirrors Streamers.tsx's initial-load handling.
        if (alive) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });

    const source = new EventSource("/api/stream");

    // `connected` is driven by EventSource's own lifecycle, not by
    // whether a "state" frame happened to arrive: the connection can be
    // open with no traffic yet, and it can drop and silently auto-
    // reconnect (EventSource fires "open" again on recovery).
    source.addEventListener("open", () => { if (alive) setConnected(true); });
    source.addEventListener("error", () => { if (alive) setConnected(false); });

    source.addEventListener("state", (event) => {
      try {
        setSnapshot(JSON.parse((event as MessageEvent).data) as StateSnapshot);
      } catch {
        // A malformed frame must never take the page down.
      }
    });

    return () => { alive = false; source.close(); };
  }, []);

  return { snapshot, connected, loadError };
}
