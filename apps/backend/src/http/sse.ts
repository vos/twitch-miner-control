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
