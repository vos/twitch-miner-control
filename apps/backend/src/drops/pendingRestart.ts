/**
 * How long the user gets to cancel an engine-initiated restart.
 *
 * Sixty seconds: long enough that someone watching the dashboard can
 * stop it before it interrupts what they are watching, short enough that
 * an unattended box resumes collecting promptly.
 */
export const RESTART_DEFERRAL_MS = 60_000;

export interface PendingState {
  pending: boolean;
  /** Epoch ms the restart fires, or null when nothing is pending. */
  dueAt: number | null;
  reason: string | null;
}

export interface PendingRestartDeps {
  supervisor: { restart(): Promise<void> };
  /**
   * Optional at construction: the SSE hub lives inside the server, which
   * is built after this, so the server attaches one via setBroadcast().
   * Until then state changes simply go unannounced -- nobody is
   * connected yet to hear them.
   */
  broadcast?: (event: string, data: unknown) => void;
  now?: () => number;
}

/**
 * A restart the engine wants, held back so a human can veto it.
 *
 * Deliberately sits ABOVE MinerSupervisor rather than inside it. The
 * supervisor's generation tracking and crash backoff are load-bearing
 * and this feature has no business in them: a deferral is an intent the
 * engine holds, not a new supervisor state. The supervisor still sees
 * exactly one ordinary restart() call, when the deferral expires.
 */
export class PendingRestart {
  private timer: NodeJS.Timeout | null = null;
  private dueAt: number | null = null;
  private reason: string | null = null;

  private broadcast: ((event: string, data: unknown) => void) | undefined;

  constructor(private readonly deps: PendingRestartDeps) {
    this.broadcast = deps.broadcast;
  }

  /** Attaches the SSE hub once the server that owns it exists. */
  setBroadcast(fn: (event: string, data: unknown) => void): void {
    this.broadcast = fn;
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  state(): PendingState {
    return {
      pending: this.timer !== null,
      dueAt: this.dueAt,
      reason: this.reason,
    };
  }

  private announce(): void {
    this.broadcast?.("pending-restart", this.state());
  }

  /**
   * Ask for a restart in RESTART_DEFERRAL_MS.
   *
   * Idempotent while one is already pending: a second proposal updates
   * the reason but neither stacks another timer nor pushes the deadline
   * out. Extending it would let a resolution that keeps flapping defer
   * the restart forever, so the subscriptions would never take effect.
   */
  propose(reason: string): void {
    this.reason = reason;
    if (this.timer !== null) {
      this.announce();
      return;
    }
    this.dueAt = this.clock() + RESTART_DEFERRAL_MS;
    this.timer = setTimeout(() => {
      void this.fire();
    }, RESTART_DEFERRAL_MS);
    this.announce();
  }

  /** Drop the pending restart. The next pass may propose a fresh one. */
  cancel(): void {
    this.clear();
    this.announce();
  }

  /** Fire it now rather than waiting out the deferral. */
  async fireNow(): Promise<void> {
    await this.fire();
  }

  private async fire(): Promise<void> {
    // Cleared first, so a fireNow() cannot leave the timer armed to
    // restart a second time a minute later.
    this.clear();
    this.announce();
    try {
      await this.deps.supervisor.restart();
    } catch {
      // A failed restart leaves the miner on the previous config, which
      // is still collecting -- the next reconciliation pass sees the
      // same difference and proposes again.
    }
  }

  private clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dueAt = null;
    this.reason = null;
  }
}
