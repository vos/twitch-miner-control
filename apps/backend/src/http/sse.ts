import type { FastifyInstance, FastifyReply } from "fastify";

export class SseHub {
  private clients = new Set<FastifyReply>();

  get clientCount(): number {
    return this.clients.size;
  }

  frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  broadcast(event: string, data: unknown): void {
    const payload = this.frame(event, data);
    for (const reply of this.clients) {
      try {
        reply.raw.write(payload);
      } catch {
        this.clients.delete(reply);
      }
    }
  }

  register(app: FastifyInstance): void {
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
      });
      reply.raw.write(": connected\n\n");
      this.clients.add(reply);
      request.raw.on("close", () => {
        this.clients.delete(reply);
      });
    });
  }
}
