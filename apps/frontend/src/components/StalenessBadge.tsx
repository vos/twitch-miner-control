import { useEffect, useState } from "react";
import classes from "./StalenessBadge.module.css";

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

/**
 * Whether the view's numbers are current, stated as quietly as the fact
 * deserves.
 *
 * Rendered as a dot and a caption rather than a badge; the CSS module
 * explains why at length. The short version: the fresh state is the
 * default state, and the default state should not be the brightest thing
 * on the page.
 *
 * The element keeps a live clock of its own -- see below -- so this stays
 * honest when frames stop arriving entirely.
 */
export function StalenessBadge({ lastUpdated, stale, pending }: {
  lastUpdated: number | null; stale: boolean;
  /**
   * The snapshot came from the backend's database and a Twitch pass is
   * still running to complete it.
   *
   * Worth saying because the frame is visibly partial: the balances are
   * as of the last poll rather than this second, and viewer counts,
   * categories and drop progress are absent until the pass lands.
   * Liveness usually is known -- it comes from the miner's own log --
   * so this no longer claims otherwise.
   */
  pending?: boolean;
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

  // Takes precedence over both branches below: while a pass is running,
  // how old the stored figures are is not the thing the reader needs.
  if (pending) {
    return (
      <span
        className={`${classes.root} ${classes.unknown}`}
        data-testid="staleness"
      >
        updating…
      </span>
    );
  }

  if (lastUpdated === null) {
    return (
      <span
        className={`${classes.root} ${classes.unknown}`}
        data-testid="staleness"
      >
        never updated
      </span>
    );
  }

  const ageMs = Date.now() - lastUpdated;
  const seconds = Math.round(ageMs / 1000);
  const effectiveStale = stale || ageMs > CLIENT_STALE_AFTER_MS;

  return (
    <span
      className={`${classes.root} ${effectiveStale ? classes.stale : ""}`}
      data-testid="staleness"
    >
      <span className={classes.dot} aria-hidden />
      {effectiveStale ? `stale · updated ${seconds}s ago` : `updated ${seconds}s ago`}
    </span>
  );
}
