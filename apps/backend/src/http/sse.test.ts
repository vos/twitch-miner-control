import Fastify from "fastify";
import { expect, test } from "vitest";
import { SseHub } from "./sse.js";

test("a broadcast with no clients does not throw", () => {
  expect(() => new SseHub().broadcast("state", { a: 1 })).not.toThrow();
});

test("formats a frame as SSE wire format", () => {
  const hub = new SseHub();
  expect(hub.frame("state", { a: 1 })).toBe('event: state\ndata: {"a":1}\n\n');
});

test("tracks client count across connect and disconnect", async () => {
  const app = Fastify();
  const hub = new SseHub();
  hub.register(app);
  await app.listen({ port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
    signal: controller.signal,
  });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  await new Promise((r) => setTimeout(r, 50));
  expect(hub.clientCount).toBe(1);

  controller.abort();
  await new Promise((r) => setTimeout(r, 50));
  expect(hub.clientCount).toBe(0);
  await app.close();
});
