import { Badge } from "@mantine/core";
import { useEffect, useState } from "react";

/**
 * How old `lastUpdated` may get before the client treats the view as
 * stale on its own, independent of the server's `stale` flag.
 *
 * The server's `stale` flag (apps/backend/src/state/service.ts) is only
 * as fresh as the last frame the browser received: if the SSE connection
 * dies, or the backend stops refreshing, the browser keeps the last
 * snapshot forever -- with whatever `stale` value it happened to carry
 * -- and a frozen dashboard looks exactly like a healthy one. The client
 * must independently notice the numbers have gone quiet.
 *
 * Matches the backend's own default `staleAfterMs` (180s, three refresh
 * cycles at the default 60s `intervalMs`) so client and server agree on
 * what "stale" means: 180s already includes slack for one missed
 * server-side refresh tick before the server itself would call the data
 * stale, so using the same number client-side does not fire early
 * relative to a healthy connection -- it only fires when frames have
 * actually stopped arriving for that same grace period.
 */
export const CLIENT_STALE_AFTER_MS = 180_000;

export function StalenessBadge({ lastUpdated, stale }: {
  lastUpdated: number | null; stale: boolean;
}) {
  // Force a re-render on a ticking clock so the locally-derived staleness
  // check below is re-evaluated even when no new snapshot ever arrives --
  // a value computed once at render time would never notice the clock
  // moving and would freeze at whatever it first rendered.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (lastUpdated === null) {
    return <Badge color="gray" data-testid="staleness">never updated</Badge>;
  }
  const ageMs = Date.now() - lastUpdated;
  const seconds = Math.round(ageMs / 1000);
  const effectiveStale = stale || ageMs > CLIENT_STALE_AFTER_MS;
  return (
    <Badge color={effectiveStale ? "orange" : "green"} data-testid="staleness">
      {effectiveStale ? `stale — updated ${seconds}s ago` : `updated ${seconds}s ago`}
    </Badge>
  );
}
