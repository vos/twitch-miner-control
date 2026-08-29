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
const STOP_GRACE_MS = 20_000;

export class Supervisor extends EventEmitter {
  state: MinerState = "STOPPED";
  restartCount = 0;
  private child: ChildProcess | null = null;
  private buffer = new LogBuffer();
  private lock: Promise<void> = Promise.resolve();
  private intentionalStop = false;
  private startedAt = 0;
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

  private setState(state: MinerState): void {
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

    // Wait for the OS to confirm the process actually exists (or fails
    // to spawn at all -- ENOENT/EACCES surface as 'error' before
    // 'spawn'). This alone is not enough of a readiness signal: 'spawn'
    // fires as soon as fork/exec succeeds, well before the child has
    // executed any of its own startup code (e.g. installing its SIGTERM
    // handler). If start() resolved immediately on 'spawn', a caller
    // that calls stop() right away could send SIGTERM before the child
    // has registered its handler, hitting the OS default disposition
    // instead of the miner's graceful-shutdown path -- not unsafe (the
    // default disposition still terminates the process), but it would
    // make stop() nondeterministically skip the miner's own cleanup. The
    // short settle delay below gives interpreter startup (signal
    // handlers are installed essentially at the top of any real
    // entrypoint, long before slow imports) time to complete first.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once("spawn", () => setTimeout(finish, 50));
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
    void this.scheduleRestart(generation, code);
  }

  private async scheduleRestart(generation: number, code: number | null): Promise<void> {
    if (this.restartCount >= (this.options.maxRestarts ?? 5)) {
      this.buffer.push(`giving up after ${this.restartCount} restarts`);
      this.setState("CRASHED");
      return;
    }
    const base = this.options.backoffBaseMs ?? 1000;
    const cap = this.options.backoffCapMs ?? 300_000;
    const delay = Math.min(base * 2 ** this.restartCount, cap);
    this.restartCount += 1;
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

  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.setState("STOPPED");
      return;
    }
    this.intentionalStop = true;
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
    this.setState("STOPPED");
  }

  restart(): Promise<void> {
    return this.serialize(async () => {
      this.setState("RESTARTING");
      await this.terminate();
      this.restartCount = 0;
      await this.spawnOnce();
    });
  }
}
