import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { NdjsonClient, NdjsonError } from "./ndjsonClient.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../../test/fixtures/echo-helper.mjs");

let client: NdjsonClient;
afterEach(async () => { await client?.stop(); });

function make(overrides = {}) {
  client = new NdjsonClient({
    command: process.execPath, args: [fixture], cwd: process.cwd(), env: {},
    ...overrides,
  });
  return client;
}

test("round-trips a request", async () => {
  await expect(make().request("ping")).resolves.toEqual({ echoed: "ping" });
});

test("matches concurrent responses to the right request", async () => {
  const c = make();
  const [a, b] = await Promise.all([c.request("one"), c.request("two")]);
  expect([a, b]).toEqual([{ echoed: "one" }, { echoed: "two" }]);
});

test("rejects when the helper never answers", async () => {
  await expect(make({ requestTimeoutMs: 100 }).request("silent")).rejects.toThrow(
    /timed out/,
  );
});

test("respawns after the helper dies and serves the next request", async () => {
  const c = make();
  const respawns: number[] = [];
  c.on("respawn", () => respawns.push(1));
  await expect(c.request("crash")).rejects.toThrow();
  await expect(c.request("ping")).resolves.toEqual({ echoed: "ping" });
  expect(respawns.length).toBe(1);
});

test("in-flight requests reject when the process exits", async () => {
  const c = make();
  const pending = c.request("silent");
  await c.request("crash").catch(() => {});
  await expect(pending).rejects.toThrow();
});

test("preserves the error code from an error response for downstream AUTH branching", async () => {
  const c = make();
  await expect(c.request("auth_fail")).rejects.toMatchObject({
    code: "AUTH",
    message: expect.stringContaining("session dead"),
  });
});

test("resolves correctly when a single response is split across multiple stdout chunks", async () => {
  const c = make();
  // Force the underlying child's stdout to deliver the JSON line to the
  // client one byte at a time, simulating a response fragmented across
  // several `data` events on a real pipe. If the client assumed
  // "one chunk == one line" instead of buffering until a newline, this
  // would either hang (never sees a complete line) or throw on parsing a
  // truncated JSON fragment.
  await expect(c.request("slow_chunks")).resolves.toEqual({ echoed: "slow_chunks" });
});

test("resolves both requests when two responses arrive in a single stdout chunk", async () => {
  const c = make();
  // The fixture buffers two responses and writes them as one combined
  // write() call once both requests have arrived, so the client's stdout
  // handler receives a single chunk containing two newline-delimited
  // JSON objects. If the client only processed the first line per chunk,
  // the second request would hang forever.
  const [a, b] = await Promise.all([
    c.request("coalesce_a"),
    c.request("coalesce_b"),
  ]);
  expect([a, b]).toEqual([{ echoed: "coalesce_a" }, { echoed: "coalesce_b" }]);
});

test("out-of-order responses resolve the correct pending request", async () => {
  const c = make();
  // The fixture answers requests in reverse order of arrival (second
  // request's response is written first). Correlation must be by `id`,
  // not by response arrival order.
  const first = c.request("reorder_first");
  const second = c.request("reorder_second");
  await expect(second).resolves.toEqual({ echoed: "reorder_second" });
  await expect(first).resolves.toEqual({ echoed: "reorder_first" });
});

test("stop() terminates the child process and does not leak handles", async () => {
  const c = make();
  await c.request("ping");
  await c.stop();
  // A second stop() must not hang or throw even though the child is
  // already gone -- guards against double-kill / double-await bugs.
  await expect(c.stop()).resolves.toBeUndefined();
});
