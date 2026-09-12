import { formatSpan } from "../lib/formatSpan.js";
import { formatLiveSpan } from "../lib/useLiveDuration.js";
import classes from "./StatusPill.module.css";

interface Props {
  /** null means the miner has never reported on this channel. */
  isOnline: boolean | null;
  /** When the current stream started; null when offline or unknown. */
  liveSince: number | null;
  /** When we last saw this channel live; null while live or if never seen. */
  lastLive: number | null;
  /** Ticking elapsed ms, for callers that have a live clock. */
  elapsed?: number | null;
}

/**
 * The one status element a streamer gets, on the dashboard and in the
 * config list.
 *
 * `isOnline === null` renders nothing. An "OFFLINE" pill is a claim we
 * have looked and the channel is down; with no data we have not looked,
 * and saying so anyway is worse than staying quiet -- particularly on the
 * config screen, which is used with the miner stopped.
 *
 * A channel we have watched and never caught live is a different case: it
 * gets a bare "OFFLINE", because that IS an observation. The two must not
 * look alike.
 *
 * The elapsed span sits in its own element so a caller that is short of
 * width can hide it and keep the state word -- see StreamerRow, where a
 * long duration would otherwise squeeze the channel name off the row.
 */
export function StatusPill({ isOnline, liveSince, lastLive, elapsed }: Props) {
  if (isOnline === null || isOnline === undefined) return null;

  if (isOnline) {
    // `elapsed` when the caller ticks its own clock (the dashboard card),
    // otherwise derived once from the snapshot -- accurate as of the fetch
    // and coarse enough not to look more precise than it is.
    const ms = elapsed ?? (liveSince === null ? null : Math.max(0, Date.now() - liveSince));
    return (
      <span className={classes.pill} data-testid="live-pill">
        <span className={classes.dot} />
        {"LIVE"}
        {ms !== null && (
          <span className={classes.span} data-testid="live-span">
            {" "}{formatLiveSpan(ms)}
          </span>
        )}
      </span>
    );
  }

  return (
    <span className={`${classes.pill} ${classes.pillOffline}`} data-testid="offline-pill">
      {"OFFLINE"}
      {lastLive != null && (
        <span className={classes.span} data-testid="offline-span">
          {" "}{formatSpan(Math.max(0, Date.now() - lastLive))}
        </span>
      )}
    </span>
  );
}
