import { STOP_GRACE_MS } from "../miner/supervisor.js";

/**
 * Resolves MINER_STOP_GRACE_MS to the Supervisor's `graceMs`.
 *
 * The miner's own shutdown takes a few seconds by design: upstream's
 * `end()` joins every background thread (campaign sync, minute watcher,
 * websocket pool), and those threads poll for shutdown every 5s, so a
 * SIGTERM'd miner takes about 5s to exit. `node --watch` blocks on the old
 * process before restarting, so a dev loop pays that on every edit.
 *
 * Lowering this in .env trades the miner's clean exit for a fast restart.
 * Anything under about 5s does so on every stop: SIGKILL skips upstream's
 * report and leaves the session to time out server-side. That is fine for
 * a throwaway dev miner and wrong for a real one, so the default never
 * cuts a shutdown short.
 *
 * Invalid values fall back to the default rather than throwing or
 * yielding NaN -- a NaN grace makes setTimeout fire immediately, which
 * would silently turn every stop into an instant SIGKILL. Zero is
 * honored (it means "SIGKILL immediately"), so this cannot be a falsy
 * check.
 */
export function resolveStopGraceMs(value: string | undefined): number {
  // `Number("")` and `Number("   ")` are 0, not NaN, so a bare
  // `MINER_STOP_GRACE_MS=` in .env would otherwise read as "SIGKILL
  // immediately" rather than as an unset variable.
  if (value === undefined || value.trim() === "") return STOP_GRACE_MS;
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 0) return STOP_GRACE_MS;
  return ms;
}
