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

import { NULL_LOG, type AppLog } from "../appLog/port.js";
import { COMPONENT, EVENT } from "../appLog/types.js";

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
  /** Where restart decisions -- including the user's vetoes -- are recorded. */
  log?: AppLog;
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

  private readonly log: AppLog;

  constructor(private readonly deps: PendingRestartDeps) {
    this.broadcast = deps.broadcast;
    this.log = (deps.log ?? NULL_LOG).child({ component: COMPONENT.DROPS });
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
    const renewed = this.timer !== null;
    this.reason = reason;
    if (renewed) {
      this.log.info({
        type: EVENT.RESTART_PROPOSED,
        msg: `restart still pending (${reason}); the deadline is not extended`,
        reason,
        dueAt: this.dueAt,
        renewed: true,
      });
      this.announce();
      return;
    }
    this.dueAt = this.clock() + RESTART_DEFERRAL_MS;
    this.log.info({
      type: EVENT.RESTART_PROPOSED,
      msg: `restart proposed (${reason}); firing in `
        + `${RESTART_DEFERRAL_MS}ms unless cancelled`,
      reason,
      dueAt: this.dueAt,
      renewed: false,
    });
    this.timer = setTimeout(() => {
      void this.fire();
    }, RESTART_DEFERRAL_MS);
    this.announce();
  }

  /** Drop the pending restart. The next pass may propose a fresh one. */
  cancel(): void {
    // Read before clear(), which discards both.
    const reason = this.reason;
    const remainingMs = this.dueAt === null ? null : this.dueAt - this.clock();
    if (this.timer !== null) {
      this.log.info({
        type: EVENT.USER_RESTART_CANCELLED,
        msg: `pending restart cancelled (${reason ?? "no reason recorded"})`,
        reason,
        remainingMs,
      });
    }
    this.clear();
    this.announce();
  }

  /** Fire it now rather than waiting out the deferral. */
  async fireNow(): Promise<void> {
    await this.fire();
  }

  private async fire(): Promise<void> {
    const reason = this.reason;
    // Cleared first, so a fireNow() cannot leave the timer armed to
    // restart a second time a minute later.
    this.clear();
    this.announce();
    this.log.info({
      type: EVENT.RESTART_FIRED,
      msg: `restarting the miner (${reason ?? "no reason recorded"})`,
      reason,
    });
    try {
      await this.deps.supervisor.restart();
    } catch (cause) {
      this.log.error({
        type: EVENT.RESTART_FAILED,
        msg: "the restart failed; the miner is still on the previous config "
          + "and the next pass will propose again",
        reason,
        err: cause instanceof Error ? cause.message : String(cause),
      });
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
