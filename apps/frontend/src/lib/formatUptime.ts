const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Renders an elapsed duration for the miner's uptime readout.
 *
 * Units are dropped from the left until the largest non-zero one leads,
 * so a miner that has been up for seconds does not read "0d 00h 00m 12s"
 * -- but every unit smaller than the leading one is kept and zero-padded,
 * because this string re-renders every second in the header and an
 * unpadded "3m 7s" -> "3m 12s" changes width on the tick, shifting the
 * controls beside it. Past a day, seconds are dropped entirely: at that
 * scale they are noise, and the operator reading a multi-day uptime cares
 * about the day count, not which second it is.
 *
 * Sub-second remainders truncate rather than round, so a timer started
 * moments ago reads "0s" instead of jumping to "1s" before a full second
 * has actually elapsed. A negative input -- possible from clock skew
 * between the server's `startedAt` and the browser's clock, or an NTP
 * step mid-session -- clamps to zero rather than rendering "-3s".
 */
export function formatUptime(elapsedMs: number): string {
  const ms = Math.max(0, elapsedMs);

  if (ms >= DAY) {
    const days = Math.floor(ms / DAY);
    const hours = Math.floor((ms % DAY) / HOUR);
    const minutes = Math.floor((ms % HOUR) / MINUTE);
    return `${days}d ${pad(hours)}h ${pad(minutes)}m`;
  }

  const hours = Math.floor(ms / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  const seconds = Math.floor((ms % MINUTE) / SECOND);

  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}
