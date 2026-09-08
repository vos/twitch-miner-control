import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";

export type LoginProgress =
  | {
      stage: "code";
      userCode: string;
      verificationUri: string;
      /**
       * Wall-clock epoch SECONDS (not milliseconds, and not monotonic) at
       * which the device code expires. Produced by
       * `python/helpers/login.py` (`wall_clock() + expires_in`, where
       * `wall_clock` defaults to `time.time`) and passed through here
       * unchanged -- Task 19 renders a countdown from it, so converting
       * units in either direction would make that countdown wrong by a
       * factor of 1000.
       */
      expiresAt: number;
    }
  | { stage: "pending" }
  | { stage: "ok"; username: string }
  | { stage: "error"; error: string };

/** Stages that mean the helper has reached a final outcome. */
const TERMINAL_STAGES = new Set<LoginProgress["stage"]>(["ok", "error"]);

function isValidProgress(value: unknown): value is LoginProgress {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  switch (o.stage) {
    case "code":
      return (
        typeof o.userCode === "string" &&
        typeof o.verificationUri === "string" &&
        typeof o.expiresAt === "number"
      );
    case "pending":
      return true;
    case "ok":
      return typeof o.username === "string";
    case "error":
      return typeof o.error === "string";
    default:
      // Covers a missing "stage" entirely and any stage this runner
      // doesn't know about (a future helper version, transient
      // corruption, ...) -- never present it to consumers as if it were
      // valid progress (Task 11 correction 5).
      return false;
  }
}

export interface LoginRunnerOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** How long cancel() waits for a clean SIGTERM exit before SIGKILL. */
  graceMs?: number;
}

/**
 * Grace period given to a SIGTERM'd login helper before cancel()
 * escalates to SIGKILL, if the caller does not override graceMs. The
 * helper can be blocked in a network call (login.py's `sleep(interval)`/
 * `send_oauth_request` poll loop against Twitch), so SIGTERM is not
 * guaranteed to be timely -- cancellation must still complete in bounded
 * time and never leak a process. Mirrors the escalate-after-grace
 * approach in apps/backend/src/miner/supervisor.ts's STOP_GRACE_MS, sized
 * much shorter here since a login helper holds no long-lived browser/
 * network session worth waiting out -- only a single OAuth poll cycle.
 */
const CANCEL_GRACE_MS = 5_000;

/**
 * Upper bound on how much stderr text is retained for the synthesized
 * error message when the helper exits without reaching a terminal stage.
 * A Python traceback's useful part is at the end, so this keeps the
 * *tail* of the accumulated text rather than the head; a few KB is far
 * more than any real traceback needs, while still bounding memory against
 * a helper that floods stderr.
 */
const STDERR_TAIL_BYTES = 4096;

export class LoginRunner extends EventEmitter {
  current: LoginProgress | null = null;
  private child: ChildProcess | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private stderrTail = "";
  /**
   * Decodes stderr across chunk boundaries. Converting each Buffer on its
   * own splits any multi-byte character that straddles two reads into
   * replacement characters -- and upstream's miner emits emoji -- so the
   * decoder holds the partial bytes until the rest arrives.
   */
  private stderrDecoder = new StringDecoder("utf8");

  constructor(private readonly options: LoginRunnerOptions) {
    super();
  }

  private get grace(): number {
    return this.options.graceMs ?? CANCEL_GRACE_MS;
  }

  start(): void {
    if (this.child) return;
    this.stderrTail = "";
    this.stderrDecoder = new StringDecoder("utf8");
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    createInterface({ input: child.stdout! }).on("line", (line) => {
      this.onLine(line);
    });

    // Must be drained: a helper that writes more than the pipe's ~64KB
    // OS buffer to stderr (e.g. a Python traceback plus surrounding
    // noise) would otherwise block forever on write() if nobody reads
    // it (Task 11 correction 2).
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text =
        typeof chunk === "string" ? chunk : this.stderrDecoder.write(chunk);
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_BYTES);
    });

    child.on("exit", (code) => this.finish(child, this.unexpectedExitProgress(code)));
    // Without this listener, a spawn failure (ENOENT for a missing
    // interpreter, EACCES for a non-executable helper, ...) emits only
    // "error" and never "exit" -- `current` would stay null, "progress"
    // would never fire, and "done" would never fire, hanging any HTTP
    // request awaiting login completion forever. This exact defect
    // shipped twice already on this branch (see supervisor.ts and
    // ndjsonClient.ts's identical comments) -- do not repeat it a third
    // time (Task 11 correction 1).
    child.on("error", (err) => {
      this.finish(child, {
        stage: "error",
        error: `failed to start login helper: ${err.message}`,
      });
    });
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isValidProgress(parsed)) return;
    this.current = parsed;
    this.emit("progress", parsed);
  }

  /**
   * Progress to force when the child exits/errors without ever having
   * reached a terminal stage on stdout. Returns null when `current` is
   * already terminal ("ok"/"error"), in which case that stands as-is.
   */
  private unexpectedExitProgress(code: number | null): LoginProgress | null {
    if (this.current !== null && TERMINAL_STAGES.has(this.current.stage)) {
      return null;
    }
    const tail = (this.stderrTail + this.stderrDecoder.end())
      .slice(-STDERR_TAIL_BYTES)
      .trim();
    const detail = tail ? `: ${tail}` : "";
    return {
      stage: "error",
      error: `login helper exited unexpectedly (code ${code})${detail}`,
    };
  }

  /**
   * Common landing point for both "exit" and "error". Guarded by child
   * identity (nulled out below) rather than a separate boolean flag:
   * once this fires for `child`, `this.child` no longer equals it, so a
   * second event from the *same* child (Node docs do not guarantee
   * "error" and "exit" are mutually exclusive) is a safe no-op, and a
   * stale event from a *previous* run's child can never clobber a
   * newer run started by a later start() call (Task 11 correction 1).
   */
  private finish(child: ChildProcess, forced: LoginProgress | null): void {
    if (this.child !== child) return;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    if (forced) {
      this.current = forced;
      this.emit("progress", forced);
    }
    this.child = null;
    this.emit("done", this.current);
  }

  cancel(): void {
    const child = this.child;
    if (!child) return; // not started, or already finished -- safe no-op.
    // A second cancel() before the child exits (e.g. a doubled shutdown
    // signal) must not orphan the first timer: overwriting `killTimer`
    // without clearing it first left that original timer scheduled with
    // no reference anyone could clear, so it fired its SIGKILL on its own
    // schedule regardless of what this call does. Clearing it here means
    // there is ever only one live killTimer for this child.
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, this.grace);
    child.kill("SIGTERM");
  }

  /** True while a login helper process is spawned and has not yet exited. */
  get running(): boolean {
    return this.child !== null;
  }
}
