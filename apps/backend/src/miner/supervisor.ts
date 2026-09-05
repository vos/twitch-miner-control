import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { LogBuffer } from "./logBuffer.js";

export type MinerState =
  | "STOPPED" | "STARTING" | "RUNNING" | "RESTARTING" | "CRASHED";

export interface SupervisorOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** How long to wait for a clean SIGTERM shutdown before SIGKILL. */
  graceMs?: number;
  /** An exit sooner than this means the config is unstartable. */
  fastExitMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  maxRestarts?: number;
  /**
   * Width of the sliding crash-rate window used to decide whether the
   * miner is crash-looping (see CRASH_WINDOW_MS below for the default
   * and rationale).
   */
  crashWindowMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Grace period given to a SIGTERM'd miner before stop() escalates to
 * SIGKILL, if the caller does not override graceMs. A miner can be
 * wedged in an uninterruptible read or holding a live network
 * connection, so SIGTERM is not guaranteed to be timely -- shutdown
 * must still complete in bounded time and never leak a process holding
 * Twitch cookies.
 */
export const STOP_GRACE_MS = 20_000;

/**
 * Width of the sliding crash-rate window used to decide whether the
 * miner is crash-looping, if the caller does not override
 * crashWindowMs.
 *
 * restartCount/maxRestarts exists to bound a *rapid crash loop*
 * (broken config, dead auth, etc. that will not fix itself), not to
 * bound the miner's total lifetime crash count. Sizing this against a
 * single run's uptime (as an earlier version of this file did) is
 * unsound: a miner that reliably survives just past that per-run
 * threshold before dying again (an expiring token, a nightly OOM at a
 * fixed uptime) would have its budget reset on every single crash, so
 * maxRestarts would never engage and the miner would restart forever
 * with no terminal operator signal. A sliding window sidesteps this by
 * judging crash *rate* rather than any one run's duration. The fastest
 * legitimate recovery sequence -- five backoff attempts in a row
 * (base * 2^n for n = 0..4, i.e. 1+2+4+8+16 multiples of
 * backoffBaseMs) -- spans only ~31 backoff units end to end, so any
 * window far longer than that cannot mistake a normal recovery
 * sequence for a crash loop. An hour is comfortably clear of that: a
 * miner that crashes once a day (e.g. a nightly OOM) never accumulates
 * two crashes in the same window and so never trips the cap, while a
 * miner crashing every few minutes (an expiring token, a wedged
 * browser session) keeps landing crashes inside the same window and
 * reaches the cap as intended.
 */
const CRASH_WINDOW_MS = 60 * 60_000;

/**
 * How long spawnOnce() waits after Node confirms the process exists
 * before it is willing to call it RUNNING, if the child neither exits
 * nor errors first. This is raced against exit/error (whichever comes
 * first wins), so a child that crashes quickly is never reported
 * RUNNING regardless of how this constant is tuned -- but it does need
 * to be generous enough to outlast realistic interpreter/runtime
 * startup jitter between process creation and the child's own code
 * actually running, or a quick-crashing child could still slip through
 * the gap between "OS confirms the process exists" and "the child's
 * own code has run long enough to crash". Measured empirically against
 * this repo's Node-based test fixture (which is far lighter than a
 * real Python interpreter with heavy imports): interpreter+module-load
 * overhead alone was ~35-50ms before any of the fixture's own code ran,
 * so a fixture configured to crash 45ms after that point exited at
 * ~95-100ms wall-clock from spawn. 250ms leaves comfortable margin over
 * that measurement for CI jitter.
 */
const SPAWN_SETTLE_MS = 250;

export class Supervisor extends EventEmitter {
  state: MinerState = "STOPPED";
  restartCount = 0;
  private child: ChildProcess | null = null;
  private buffer = new LogBuffer();
  private lock: Promise<void> = Promise.resolve();
  private intentionalStop = false;
  private startedAt = 0;
  /**
   * Timestamps (Date.now()) of unintentional crashes still inside the
   * crash-rate window, oldest first. Pruned on every new crash so it
   * never grows unbounded; an unbroken healthy stretch of one window's
   * width empties it out completely.
   */
  private crashTimes: number[] = [];
  /**
   * Monotonically increasing id for the current child process
   * "generation". Exit/error handlers close over the generation they
   * were registered for and bail out if a respawn has since moved
   * `this.generation` on, so a stale event from a superseded child can
   * never corrupt the new generation's state (e.g. a slow-to-die old
   * process from restart() landing its exit event after the new child
   * is already RUNNING).
   */
  private generation = 0;

  constructor(private readonly options: SupervisorOptions) {
    super();
  }

  private get grace() { return this.options.graceMs ?? STOP_GRACE_MS; }
  private get fastExit() { return this.options.fastExitMs ?? 10_000; }
  private get crashWindow() { return this.options.crashWindowMs ?? CRASH_WINDOW_MS; }

  private setState(state: MinerState): void {
    // Guard against re-emitting a state the caller is already in --
    // e.g. three redundant stop() calls on an already-STOPPED
    // supervisor would otherwise fire "state" three more times, and a
    // UI naively rendering "miner stopped" toast-per-event would spam
    // the operator.
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  /** Serializes every lifecycle operation so concurrent callers cannot race. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  logs(): string[] { return this.buffer.lines(); }

  /**
   * When the live miner process started, or null if none is running.
   *
   * `startedAt` alone cannot answer this: it is set on spawn and never
   * cleared, so a stopped or crashed miner still holds the timestamp of
   * the run that ended. The dashboard renders a ticking uptime from this
   * value, and a timer that keeps counting for a process that exited half
   * an hour ago is worse than no timer at all -- it is the exact signal an
   * operator would use to conclude the miner is healthy. Gated on a live
   * child AND on the state being RUNNING, because either test alone is
   * wrong at some point in the lifecycle: through STARTING a child exists
   * but is not yet confirmed, and restart() announces RESTARTING while the
   * outgoing child is still alive, so a live-child test alone hands the
   * RESTARTING frame the dying run's timestamp and a dashboard ticks uptime
   * for a process being killed. Requiring both means the answer always
   * agrees with the state it is reported beside.
   */
  get runningSince(): number | null {
    if (this.state !== "RUNNING") return null;
    if (!this.child || this.child.exitCode !== null) return null;
    return this.startedAt === 0 ? null : this.startedAt;
  }

  livePids(): number[] {
    return this.child && this.child.exitCode === null && this.child.pid
      ? [this.child.pid]
      : [];
  }

  start(): Promise<void> {
    return this.serialize(() => this.spawnOnce());
  }

  private async spawnOnce(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    this.setState("STARTING");
    this.intentionalStop = false;
    this.startedAt = Date.now();
    const generation = ++this.generation;

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => this.buffer.push(String(d)));
    child.stderr?.on("data", (d) => this.buffer.push(String(d)));
    child.on("exit", (code) => this.onExit(generation, code));
    // Without this listener, a spawn failure (e.g. ENOENT for a bad
    // python/venv path) makes Node throw on the unhandled 'error' event
    // and kill the entire backend process instead of surfacing as a
    // rejected/settled promise. spawn() returns synchronously before
    // this can fire, so we must wait for either a confirmed live
    // process or this error before resolving start().
    child.on("error", (err) => this.onSpawnError(generation, err));
    this.child = child;

    // Wait for the OS to confirm the process actually exists (the
    // 'spawn' event), THEN race a short settle window against the child
    // dying (exit/error) before we're willing to call it RUNNING.
    // Whichever happens first wins: if the child exits/errors at any
    // point -- including partway through the settle window -- `finish`
    // is called immediately by that event, `settled` short-circuits the
    // timer's later call, and the code below sees a non-null exitCode
    // and skips straight past the RUNNING transition. This is what
    // makes a quick-crashing child (e.g. delayed_crash with a short
    // DIE_AFTER_MS) reliably observed as CRASHED rather than
    // momentarily reported RUNNING: onExit/onSpawnError already move
    // the state to CRASHED as soon as their event fires, and nothing
    // here can clobber that back to RUNNING afterwards, because the
    // exitCode check below runs after the same event has already been
    // observed by this race.
    //
    // The settle window itself (SPAWN_SETTLE_MS, see above) is
    // deliberately NOT a production safety mechanism for signal
    // delivery: stop() and start() both route through the same
    // serialize() lock, so a stop() called during this window queues
    // behind spawnOnce() rather than racing it, and SIGTERM can never
    // be sent early or dropped as a result of this delay. Its only job
    // is to give a child that's about to crash enough real wall-clock
    // time to actually do so before we give up waiting and assume it's
    // alive; it is cheap insurance against a future refactor that calls
    // kill() directly (bypassing the lock) too.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("spawn", () => setTimeout(finish, SPAWN_SETTLE_MS));
      child.once("exit", finish);
      child.once("error", finish);
    });
    if (this.generation !== generation || this.child !== child) {
      // onSpawnError (or a concurrent respawn) already moved us on.
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      // Exited or errored out during the settle window; onExit/
      // onSpawnError already handled the state transition.
      return;
    }
    this.setState("RUNNING");
  }

  private onSpawnError(generation: number, err: Error): void {
    if (generation !== this.generation) return;
    this.child = null;
    this.buffer.push(`failed to start miner: ${err.message}`);
    this.setState("CRASHED");
  }

  private onExit(generation: number, code: number | null): void {
    // Guard against a stale exit handler firing after a restart/respawn
    // has already replaced this.child with a newer generation.
    if (generation !== this.generation) return;

    const uptime = Date.now() - this.startedAt;
    this.child = null;
    if (this.intentionalStop) {
      this.setState("STOPPED");
      return;
    }
    if (uptime < this.fastExit) {
      // Exited almost immediately: the config or environment is broken.
      // Retrying cannot help and risks hammering Twitch auth.
      this.buffer.push(`miner exited after ${uptime}ms with code ${code}`);
      this.setState("CRASHED");
      return;
    }
    // Record this crash and evict anything that has aged out of the
    // window, rather than resetting the whole budget based on how long
    // this one run happened to stay up (see CRASH_WINDOW_MS above for
    // why the latter is unsound). restartCount is kept as the current
    // window's crash count -- a healthy miner that crashes rarely sees
    // this settle back down to 1 each time, while a genuine crash loop
    // sees it climb.
    const now = Date.now();
    this.crashTimes.push(now);
    this.crashTimes = this.crashTimes.filter((t) => now - t <= this.crashWindow);
    this.restartCount = this.crashTimes.length;
    void this.scheduleRestart(generation, code);
  }

  private async scheduleRestart(generation: number, code: number | null): Promise<void> {
    if (this.restartCount > (this.options.maxRestarts ?? 5)) {
      this.buffer.push(
        `giving up after ${this.restartCount} restarts within ${this.crashWindow}ms`,
      );
      this.setState("CRASHED");
      return;
    }
    // The miner has crashed and a restart is pending: it is not running,
    // and must not be reported as RUNNING (e.g. to a dashboard) while
    // this backoff sleep is in flight. RESTARTING is the existing state
    // that best matches "no live miner right now, but the supervisor is
    // actively working towards one" -- the same meaning restart()
    // already gives it for a caller-initiated cycle, so callers get one
    // consistent "don't treat this as healthy nor as terminal" signal
    // rather than a new state value that every consumer would need to
    // learn to handle identically anyway.
    this.setState("RESTARTING");
    const base = this.options.backoffBaseMs ?? 1000;
    const cap = this.options.backoffCapMs ?? 300_000;
    // restartCount was just set (in onExit) to this crash's ordinal
    // position within the current window, so restartCount - 1 is the
    // number of restarts already attempted within this window --
    // exactly the exponent the pre-window code derived from its
    // monotonic counter for an unbroken crash loop. For a miner that
    // recovers and re-enters the window after some entries have aged
    // out, this naturally (and desirably) shrinks the exponent back
    // down too, instead of the backoff delay ratcheting up forever
    // over the miner's entire lifetime.
    const delay = Math.min(base * 2 ** (this.restartCount - 1), cap);
    this.buffer.push(`miner exited (code ${code}); restarting in ${delay}ms`);
    await sleep(delay);
    // A stop()/restart() may have happened while we were sleeping;
    // bail out rather than resurrecting a miner the caller deliberately
    // stopped, and never spawn on top of a newer generation.
    if (generation !== this.generation || this.intentionalStop) return;
    await this.serialize(() => this.spawnOnce());
  }

  stop(): Promise<void> {
    return this.serialize(() => this.terminate());
  }

  /**
   * @param finalState state to settle into once the process is confirmed
   * gone. terminate() itself is also used mid-restart() (where the
   * caller wants to stay in RESTARTING rather than have terminate()
   * announce a transient STOPPED that immediately flips to STARTING).
   */
  private async terminate(finalState: MinerState = "STOPPED"): Promise<void> {
    // This flag -- and bumping the generation counter -- must be set
    // BEFORE any early return, not after. A miner that has crashed past
    // fastExitMs has this.child === null while scheduleRestart() sleeps
    // in its backoff window with a respawn pending. The early return
    // below is exactly the path a stop() call takes in that situation
    // (there is no live child to signal), so if intentionalStop were set
    // only after it, an operator's stop() would silently no-op here,
    // the pending restart's generation check would still pass, and the
    // miner would resurrect itself once the backoff delay elapsed --
    // reporting STOPPED to the operator while a live Twitch session
    // came back moments later. Bumping the generation here too makes
    // this defence-in-depth rather than a single point of failure: even
    // if intentionalStop were somehow missed, scheduleRestart's
    // generation check would still catch it.
    this.intentionalStop = true;
    // Bumping the generation here means the child's own onExit/
    // onSpawnError handlers (registered in spawnOnce with the OLD
    // generation number) will see a mismatch and bail out without
    // touching this.child or state themselves once this process
    // actually exits below -- so terminate() must take over both of
    // those responsibilities itself rather than deferring to them.
    this.generation += 1;

    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      this.setState(finalState);
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      child.once("exit", finish);
      // If the miner is wedged (e.g. blocked in an uninterruptible read
      // or a live network call) SIGTERM alone may never be honored --
      // escalate to SIGKILL after a bounded grace period so stop()
      // always completes and never leaks a process holding Twitch
      // cookies. The timer is cleared above on normal exit so it can
      // never fire kill() on an already-reaped pid or keep the event
      // loop alive after shutdown.
      const killTimer = setTimeout(() => {
        this.buffer.push("miner ignored SIGTERM; sending SIGKILL");
        child.kill("SIGKILL");
      }, this.grace);
      child.kill("SIGTERM");
    });
    // The generation bump above means onExit (registered against the
    // old generation) will no-op on this child's exit event, so null it
    // out here instead of relying on onExit to do it.
    if (this.child === child) this.child = null;
    this.setState(finalState);
  }

  restart(): Promise<void> {
    return this.serialize(async () => {
      this.setState("RESTARTING");
      // Pass "RESTARTING" through so terminate() re-asserts the state
      // we're already in instead of settling into STOPPED -- otherwise
      // a state-change listener would see the spurious sequence
      // RESTARTING -> STOPPED -> STARTING -> RUNNING and a UI could
      // flash "miner stopped" mid-restart even though the miner was
      // never actually left in a stopped, idle state.
      await this.terminate("RESTARTING");
      // An operator-initiated restart is not a crash; clear the crash
      // history too, not just the count, so it stays consistent with
      // restartCount and a subsequent genuine crash starts a fresh
      // window rather than inheriting history from before the operator
      // stepped in.
      this.restartCount = 0;
      this.crashTimes = [];
      await this.spawnOnce();
    });
  }
}
