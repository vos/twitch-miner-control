import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";

export interface NdjsonClientOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  requestTimeoutMs?: number;
}

/** Error codes the helper protocol can report on a failed request (Task 6). */
export type NdjsonErrorCode = "AUTH" | "GQL" | "BAD_REQUEST";

/**
 * Error raised for a helper-reported failure ({ok:false}) response.
 *
 * Carries the protocol's `code` field (when present) so callers -- notably
 * the login-status and streamer-state routes added in later tasks -- can
 * branch on "AUTH" (session dead, prompt re-login) versus other failures
 * without parsing the error message.
 */
export class NdjsonError extends Error {
  readonly code: NdjsonErrorCode | undefined;

  constructor(message: string, code: NdjsonErrorCode | undefined) {
    super(message);
    this.name = "NdjsonError";
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface ResponseMessage {
  id?: number;
  ok?: boolean;
  data?: unknown;
  error?: string;
  code?: NdjsonErrorCode;
}

/**
 * Grace period given to a SIGTERM'd helper before stop() escalates to
 * SIGKILL. A helper can be blocked in an uninterruptible read (state.py's
 * `for line in stdin`) or a network call, so SIGTERM is not guaranteed to
 * be timely -- shutdown must still complete in bounded time.
 */
const STOP_GRACE_MS = 2_000;

export class NdjsonClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private reader: Interface | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stopped = false;
  private readonly timeoutMs: number;

  constructor(private readonly options: NdjsonClientOptions) {
    super();
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      return this.child;
    }
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const reader = createInterface({ input: child.stdout! });
    reader.on("line", (line) => this.onLine(line));
    child.on("exit", (code) => this.onExit(child, code));
    // Without this listener, a spawn failure (e.g. ENOENT for a bad
    // command path) makes Node throw on the unhandled 'error' event and
    // kill the whole process instead of surfacing as a rejected promise.
    // `spawn` returns synchronously before this fires, so any request(s)
    // already queued against this child must be rejected here.
    child.on("error", (err) => this.onSpawnError(child, err));
    // stdin is a stream of its own and does NOT inherit the child's "error"
    // handler. ensure() hands back a child whose exitCode and signalCode are
    // both still null for the whole window between the OS process dying and
    // Node delivering "exit" -- a window a synchronous better-sqlite3 write
    // or a doorbell burst can hold open for hundreds of milliseconds. A
    // write() into that dead pipe raises EPIPE on this stream, and with no
    // listener Node turns it into an uncaught exception that kills the
    // backend outright -- bypassing the SIGTERM handler in index.ts and so
    // orphaning the miner and both helpers, which is exactly the harm that
    // handler exists to prevent. The pending request is failed by the
    // per-write callback in request(); this listener only has to keep the
    // event from being fatal.
    child.stdin?.on("error", () => {});
    this.reader = reader;
    this.child = child;
    return child;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: ResponseMessage;
    try {
      message = JSON.parse(line) as ResponseMessage;
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      // The helper's bad-JSON path (python/helpers/state.py:167-169) has
      // no request id to correlate against -- it responds with
      // `{"id": None, ...}` because it never got far enough to parse one.
      // We cannot silently drop this: the caller who sent the malformed
      // request would otherwise stall for the full timeout with a
      // generic "timed out" message instead of the real BAD_REQUEST
      // diagnostic. If exactly one request is in flight, it's the only
      // plausible sender, so attribute the error to it directly. With
      // zero or multiple requests in flight we can't attribute
      // ownership, so surface it as an "unattributed-error" event instead
      // of dropping it on the floor.
      if (!message.ok) {
        if (this.pending.size === 1) {
          const [[onlyId, entry]] = this.pending;
          this.pending.delete(onlyId);
          clearTimeout(entry.timer);
          entry.reject(new NdjsonError(message.error ?? "helper error", message.code));
        } else {
          this.emit(
            "unattributed-error",
            new NdjsonError(message.error ?? "helper error", message.code),
          );
        }
        return;
      }
      // A *success* frame with no id is a helper bug -- the protocol always
      // echoes the request id back (python/helpers/state.py:104-122), so no
      // correct helper can produce this. It used to be dropped on the floor,
      // which stalled whoever sent that request for the full 30s timeout and
      // then blamed it on a timeout. It cannot be attributed the way an
      // error frame can (resolving some caller with data that may not be
      // theirs is worse than failing), so surface it on the same channel
      // the unattributable-error path uses.
      this.emit(
        "unattributed-error",
        new NdjsonError("helper sent a success response with no request id", undefined),
      );
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.data);
    } else {
      entry.reject(new NdjsonError(message.error ?? "helper error", message.code));
    }
  }

  /**
   * Settles one pending request with an error, if it is still pending.
   * Idempotent: onExit() may already have rejected and removed it.
   */
  private fail(id: number, error: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(error);
  }

  private onExit(child: ChildProcess, code: number | null): void {
    // Guard against a stale exit handler firing after a respawn has
    // already replaced this.child with a newer process.
    if (this.child !== child) return;

    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`helper exited with code ${code}`));
      this.pending.delete(id);
    }
    this.reader?.close();
    this.reader = null;
    this.child = null;
    if (!this.stopped) this.emit("respawn");
  }

  private onSpawnError(child: ChildProcess, err: Error): void {
    // Guard against a stale error handler firing after a respawn has
    // already replaced this.child with a newer process.
    if (this.child !== child) return;

    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(
        new Error(`failed to start helper "${this.options.command}": ${err.message}`),
      );
      this.pending.delete(id);
    }
    this.reader?.close();
    this.reader = null;
    this.child = null;
    // Deliberately no "respawn" emit here: nothing was ever successfully
    // running, so there's nothing to notify listeners "came back" from.
    // The client is left in a clean state -- this.child is null, so the
    // next request() call will retry ensure()/spawn() from scratch.
  }

  async request<T>(op: string, params: object = {}): Promise<T> {
    if (this.stopped) {
      throw new Error(`cannot send request "${op}": client has been stopped`);
    }
    const child = this.ensure();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`helper request "${op}" timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void, reject, timer,
      });
      // Envelope fields must win over caller-supplied params -- spreading
      // params last would let a param literally named "op" or "id"
      // silently redirect which operation runs or desync response
      // correlation (see python/helpers/state.py:100,106, which reads
      // fields like "username"/"streamers" flat off the same object, so
      // params must stay a flat spread rather than nested).
      child.stdin!.write(`${JSON.stringify({ ...params, id, op })}\n`, (err) => {
        // Reached when the pipe is already gone (EPIPE) or the stream was
        // destroyed: the helper died and "exit" has not been delivered yet,
        // so onExit() has not rejected anything and never will for this id.
        // Fail this one request instead of letting it hang to the timeout.
        if (err) this.fail(id, new Error(`helper request "${op}" failed: ${err.message}`));
      });
    });
  }

  /**
   * Retires the client for good. `request()` throws afterwards -- use
   * `restart()` if the helper needs replacing but the client kept alive.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.killChild();
  }

  /**
   * Replaces the helper process without retiring the client: the next
   * `request()` spawns a fresh child through `ensure()`.
   *
   * Needed because a helper's environment is fixed for the life of its
   * process, and this one outlives changes to it. `python/helpers/_session.py`
   * derives the cookie pickle path from TWITCH_USERNAME once, at startup,
   * and `reload_cookies()` re-reads that same frozen path forever after --
   * so a helper spawned before the user's Twitch username was known keeps
   * reading `cookies/.pkl` no matter what the config later says. Only a new
   * process fixes that.
   *
   * Any in-flight request is rejected by the exit handler, exactly as for
   * an unexpected exit; callers that still want the answer must re-issue.
   * A no-op once `stop()` has been called -- stop is final.
   */
  async restart(): Promise<void> {
    if (this.stopped) return;
    await this.killChild();
  }

  /**
   * Terminates the current child, if one is live, and resolves once it is
   * gone. Leaves `stopped` untouched -- the caller decides whether this is
   * a retirement or a recycle.
   */
  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
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
      // If the helper is wedged (e.g. blocked in an uninterruptible read
      // or a network call) SIGTERM alone may never be honored -- escalate
      // to SIGKILL after a bounded grace period so stop() always
      // completes and never leaks a live process holding Twitch cookies.
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, STOP_GRACE_MS);
      child.stdin?.end();
      child.kill("SIGTERM");
    });
  }
}
