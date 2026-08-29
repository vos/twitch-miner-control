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
      }
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
      child.stdin!.write(`${JSON.stringify({ ...params, id, op })}\n`);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
