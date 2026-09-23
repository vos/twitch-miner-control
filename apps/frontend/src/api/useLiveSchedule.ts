import { useEffect, useState } from "react";
import { api } from "./client.js";

export interface ScheduleResponse {
  since: number;
  now: number;
  spans: Array<{ start: number; end: number }>;
}

/**
 * The channel's live spans for the schedule grid, fetched once per open.
 *
 * Not refetched on the dialog's range changes: the grid has its own fixed
 * window. Null login (dialog closed) clears it, so opening another channel
 * never shows the previous one's grid.
 */
export function useLiveSchedule(login: string | null): {
  data: ScheduleResponse | null;
  error: string | null;
} {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    if (login === null) return;
    let live = true;
    api.get<ScheduleResponse>(`/api/streamers/${encodeURIComponent(login)}/schedule`)
      .then((body) => {
        if (!live) return;
        // Checked rather than trusted: a body without spans would throw
        // inside the grid and take the whole dialog down with it.
        if (!Array.isArray(body?.spans)) throw new Error("malformed schedule");
        setData(body);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : "failed to load schedule");
      });
    return () => { live = false; };
  }, [login]);

  return { data, error };
}
