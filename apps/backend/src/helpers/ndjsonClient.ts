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
    if (typeof message.id !== "number") return;
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

  async request<T>(op: string, params: object = {}): Promise<T> {
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
      child.stdin!.write(`${JSON.stringify({ id, op, ...params })}\n`);
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
      child.once("exit", () => resolve());
      child.stdin?.end();
      child.kill("SIGTERM");
    });
  }
}
