import { useEffect, useState } from "react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * How long a stream has been running, for the LIVE badge.
 *
 * Deliberately not `formatUptime`: that one keeps seconds and pads every
 * unit so the header's readout cannot change width on the tick. In a
 * badge, seconds would repaint the loudest element on the card once a
 * second to show a digit nobody is reading, and the padding makes a
 * string that is already competing for room longer still.
 *
 * Minutes are padded only when an hour leads, so "5m" stays short while
 * "3h 07m" keeps its columns.
 */
export function formatLiveSpan(ms: number): string {
  const value = Math.max(0, ms);
  if (value >= DAY) {
    return `${Math.floor(value / DAY)}d ${pad(Math.floor((value % DAY) / HOUR))}h`;
  }
  if (value >= HOUR) {
    return `${Math.floor(value / HOUR)}h ${pad(Math.floor((value % HOUR) / MINUTE))}m`;
  }
  return `${Math.floor(value / MINUTE)}m`;
}

/**
 * Ticks the elapsed time since `since`, or null when there is nothing
 * running.
 *
 * Ticks once a minute, not once a second: the rendered string only
 * changes at minute granularity, so a faster interval would re-render
 * every card sixty times for each visible change.
 */
export function useLiveDuration(since: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(timer);
  }, [since]);

  return since === null ? null : Math.max(0, now - since);
}
