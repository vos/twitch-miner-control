/** Failed attempts from one address before it is locked out. */
export const MAX_ATTEMPTS = 10;

/** How long a lockout lasts, and the window failures are counted over. */
export const LOCKOUT_MS = 15 * 60 * 1000;

interface Record_ {
  failures: number;
  /** When the current window -- or, once locked, the lockout -- expires. */
  expiresAt: number;
}

/**
 * Per-address throttle for the login endpoint.
 *
 * `POST /api/session` is the one route that turns an unauthenticated caller
 * into an authenticated one, and it guards a single human-chosen password
 * with no second factor. Unthrottled that is an offline-speed guessing
 * target reachable over the network, and one hit buys a full 24h session.
 *
 * The counter is in-memory and per-process, matching the session store it
 * sits beside: a restart clears it. That is an accepted limit, not an
 * oversight -- restarting is not something an attacker can trigger, and the
 * alternative is a persistence layer for state that is worthless after a
 * reboot.
 *
 * Counting is by address, so one abusive client cannot lock out the whole
 * household -- but see `keyFor` in auth.ts for why the address is only
 * trustworthy behind a proxy that is actually setting the header.
 */
export class LoginLimiter {
  private readonly records = new Map<string, Record_>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxAttempts: number = MAX_ATTEMPTS,
    private readonly lockoutMs: number = LOCKOUT_MS,
  ) {}

  /** Seconds until `key` may try again, or 0 if it is not locked out. */
  retryAfter(key: string): number {
    const record = this.records.get(key);
    if (record === undefined) return 0;
    const remaining = record.expiresAt - this.now();
    if (remaining <= 0) {
      this.records.delete(key);
      return 0;
    }
    if (record.failures < this.maxAttempts) return 0;
    return Math.ceil(remaining / 1000);
  }

  /** Records a failed attempt. Returns true once `key` is locked out. */
  fail(key: string): boolean {
    const at = this.now();
    // Sweep on write so addresses that never come back cannot accumulate
    // unbounded -- the same lazy-eviction bargain the session map makes.
    for (const [other, record] of this.records) {
      if (at >= record.expiresAt) this.records.delete(other);
    }
    const existing = this.records.get(key);
    const record =
      existing === undefined || at >= existing.expiresAt
        ? { failures: 0, expiresAt: at + this.lockoutMs }
        : existing;
    record.failures += 1;
    // Re-arm the clock on the failure that trips the limit, so the lockout
    // runs from that moment rather than from the start of the window it
    // happened to land in.
    if (record.failures === this.maxAttempts) record.expiresAt = at + this.lockoutMs;
    this.records.set(key, record);
    return record.failures >= this.maxAttempts;
  }

  /**
   * Clears the counter for `key` after a successful login, so an operator
   * who fatfingers their password a few times and then gets it right is not
   * left carrying those failures toward a later lockout.
   */
  succeed(key: string): void {
    this.records.delete(key);
  }
}
