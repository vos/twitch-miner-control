import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * How often an otherwise-idle stream gets a comment frame.
 *
 * Comfortably under the 60s idle timeout that nginx (proxy_read_timeout),
 * most load balancers and several corporate proxies apply by default.
 */
export const HEARTBEAT_MS = 15_000;

export interface SseHubOptions {
  /** Overridable so tests need not wait a real heartbeat period. */
  heartbeatMs?: number;
}

export class SseHub {
  private clients = new Set<FastifyReply>();
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly heartbeatMs: number;

  constructor(options: SseHubOptions = {}) {
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  broadcast(event: string, data: unknown): void {
    this.write(this.frame(event, data));
  }

  /** Writes to every client, dropping any whose socket has gone away. */
  private write(payload: string): void {
    for (const reply of this.clients) {
      try {
        reply.raw.write(payload);
      } catch {
        this.clients.delete(reply);
      }
    }
  }

  /**
   * Stops the heartbeat timer. Called on shutdown; the timer is unref'd so
   * it would not hold the process open regardless, but leaving it armed
   * across a test's lifetime leaks into whatever runs next.
   */
  stop(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  register(app: FastifyInstance): void {
    // Traffic is entirely event-driven -- the state service emits "change"
    // only when the snapshot actually differs -- so a stream can legitimately
    // sit silent for many minutes while nothing on Twitch moves. Proxies and
    // OS-level idle timers read that silence as a dead connection and cut it,
    // EventSource fires "error", and the header badge flips to "live updates
    // disconnected" even though nothing is wrong. A comment frame (a line
    // starting with ":") is ignored by EventSource but is real bytes on the
    // wire, which resets every idle timer in the path.
    this.heartbeat ??= setInterval(() => this.write(": ping\n\n"), this.heartbeatMs);
    // Never let a keepalive for zero clients keep the process alive.
    this.heartbeat.unref();
    // index.ts's SIGTERM handler shuts down via app.close(); tying the timer
    // to that means callers never have to remember to stop the hub too.
    app.addHook("onClose", () => { this.stop(); });

    app.get("/api/stream", (request, reply) => {
      // This handler takes over the socket and never calls reply.send(), so
      // Fastify must be told to stop managing the reply. Without hijack()
      // the reply stays pending for the life of the connection and any
      // onSend/onResponse hook in this scope -- the auth scope the server
      // registers this in already has an onRequest hook, and Task 20 adds
      // more -- would later try to write headers to a socket that already
      // has them.
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // nginx buffers proxied responses by default, which holds frames
        // back until its buffer fills -- turning a live stream into
        // batched delivery. This header opts the route out.
        "X-Accel-Buffering": "no",
      });
      reply.raw.write(": connected\n\n");
      this.clients.add(reply);
      request.raw.on("close", () => {
        this.clients.delete(reply);
      });
    });
  }
}
