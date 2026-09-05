import { STOP_GRACE_MS } from "../miner/supervisor.js";

/**
 * Resolves MINER_STOP_GRACE_MS to the Supervisor's `graceMs`.
 *
 * The miner's own shutdown is slow by design: upstream's `end()` joins
 * every background thread (campaign sync, minute watcher, websocket
 * pool), and those threads sleep on long intervals, so a SIGTERM'd miner
 * routinely takes ~15s to exit. Production wants to absorb that wait --
 * a clean exit flushes the miner's report and releases its Twitch
 * session. A dev loop does not: `node --watch` blocks on the old process
 * before restarting, so the same 15s is paid on every single edit.
 *
 * Lowering this in .env trades the miner's clean exit for a fast restart.
 * It is deliberately not lowered by default: SIGKILL skips upstream's
 * report and leaves the session to time out server-side, which is fine
 * for a dev miner and wrong for a real one.
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
