import Fastify from "fastify";
import { expect, test } from "vitest";
import { HEARTBEAT_MS, SseHub } from "./sse.js";

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

/** Opens a real SSE client and returns the text it receives. */
async function connect(hub: SseHub, app: ReturnType<typeof Fastify>) {
  await app.listen({ port: 0 });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${port}/api/stream`, {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    } catch {
      // Aborting the request rejects the pending read; expected at teardown.
    }
  })();
  await new Promise((r) => setTimeout(r, 50));
  return { response, get text() { return received; }, controller };
}

test("writes a heartbeat comment to an idle client", async () => {
  const app = Fastify();
  // A short period keeps the test fast; production uses HEARTBEAT_MS.
  const hub = new SseHub({ heartbeatMs: 20 });
  hub.register(app);
  const client = await connect(hub, app);

  await new Promise((r) => setTimeout(r, 90));

  expect(client.text).toContain(": ping\n\n");

  client.controller.abort();
  hub.stop();
  await app.close();
});

test("stop() halts heartbeats", async () => {
  const app = Fastify();
  const hub = new SseHub({ heartbeatMs: 20 });
  hub.register(app);
  const client = await connect(hub, app);

  hub.stop();
  const settled = client.text;
  await new Promise((r) => setTimeout(r, 90));

  expect(client.text).toBe(settled);

  client.controller.abort();
  await app.close();
});

test("sets X-Accel-Buffering so nginx does not buffer the stream", async () => {
  const app = Fastify();
  const hub = new SseHub();
  hub.register(app);
  const client = await connect(hub, app);

  expect(client.response.headers.get("x-accel-buffering")).toBe("no");

  client.controller.abort();
  hub.stop();
  await app.close();
});
