import { useEffect, useState } from "react";
import { api } from "./client.js";
import { rangeWindow, type RangeKey } from "../lib/detailRanges.js";
import type { PointSample } from "../lib/bucketPoints.js";
import type { DetailSession } from "../lib/sessionRows.js";
import type { Span } from "../lib/coverageRows.js";

export interface StreamerDetail {
  series: PointSample[];
  events: { ts: number; type: string; message: string | null }[];
  sessions: DetailSession[];
  coverage: { live: Span[]; mined: Span[] };
  firstSeen: number | null;
  /** The oldest point sample that survived pruning, or null. */
  retentionFloor: number | null;
}

/**
 * Loads one streamer's history, once per open and once per range change.
 *
 * Deliberately not live: the dialog is read for seconds, and reconciling
 * an SSE frame against fetched history would buy very little. The header
 * above it renders from the dashboard's own snapshot, so the figures a
 * viewer watches move are live regardless.
 *
 * A stale response is dropped rather than applied: switching range twice
 * quickly can land the first answer after the second, which would
 * silently show the wrong window.
 */
export function useStreamerDetail(login: string | null, range: RangeKey): {
  detail: StreamerDetail | null;
  loading: boolean;
  error: string | null;
} {
  const [detail, setDetail] = useState<StreamerDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (login === null) {
      // Closing clears the last channel's history, so opening another
      // never paints its header over the previous one's charts.
      setDetail(null);
      setLoading(false);
      setError(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    const { from, to } = rangeWindow(range, Date.now());
    const query = new URLSearchParams({
      streamer: login, from: String(from), to: String(to),
    });
    api.get<StreamerDetail>(`/api/history?${query}`)
      .then((body) => {
        if (!live) return;
        setDetail(body);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : "failed to load history");
        setLoading(false);
      });
    return () => { live = false; };
  }, [login, range]);

  return { detail, loading, error };
}
