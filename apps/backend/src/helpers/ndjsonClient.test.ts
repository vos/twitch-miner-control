import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { NdjsonClient, NdjsonError } from "./ndjsonClient.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../../test/fixtures/echo-helper.mjs");
const stubbornFixture = join(here, "../../test/fixtures/stubborn-helper.mjs");

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

test("a spawn failure rejects in-flight requests without crashing the process", async () => {
  // Point at a command that cannot possibly exist. Node's ChildProcess
  // emits an async 'error' event (after spawn() already returned) for
  // this; without a listener for it, Node throws on the unhandled event
  // and kills this whole test process -- so simply reaching an assertion
  // afterward is itself part of what this test proves.
  const c = make({ command: "/no/such/binary-xyz-does-not-exist" });
  await expect(c.request("ping")).rejects.toThrow(
    /failed to start helper|ENOENT/,
  );
  // The process is still alive and the test runner did not crash -- proven
  // by the fact this line executes at all.
  expect(process.exitCode ?? 0).toBe(0);
});

test("a spawn failure leaves the client able to retry cleanly on a later request", async () => {
  const c = make({ command: "/no/such/binary-xyz-does-not-exist" });
  await expect(c.request("ping")).rejects.toThrow();
  // Swap in a real command for the next attempt is not possible (options
  // are fixed at construction), but we can at least assert a second
  // request against the same broken command fails the same clean way
  // rather than hanging or throwing something unrelated (e.g. writing to
  // a stale/half-initialized child).
  await expect(c.request("ping")).rejects.toThrow(
    /failed to start helper|ENOENT/,
  );
});

test("a param named 'op' or 'id' cannot hijack the envelope", async () => {
  const c = make();
  const result = await c.request<{ receivedOp: string; rest: Record<string, unknown> }>(
    "echo_params",
    { op: "hacked", id: 9999, username: "alice" },
  );
  // The op actually executed must be the one passed to request(), not the
  // one hidden inside params -- and the extra "op"/"id" keys must not
  // leak through into the params the helper sees either.
  expect(result.receivedOp).toBe("echo_params");
  expect(result.rest).toEqual({ username: "alice" });
});

test("a param named 'id' cannot desync response correlation", async () => {
  const c = make();
  // If params.id ever won over the envelope id, this request would be
  // sent under id 9999 while the client is really waiting on its own
  // internally-assigned id -- the real response would then never match
  // anything in `pending`, and the request would hang to timeout instead
  // of resolving.
  await expect(
    c.request("ping", { id: 9999 }),
  ).resolves.toEqual({ echoed: "ping" });
});

test("stop() escalates to SIGKILL and completes within a bounded time when the helper ignores SIGTERM", async () => {
  const c = new NdjsonClient({
    command: process.execPath, args: [stubbornFixture], cwd: process.cwd(), env: {},
  });
  client = c;
  await c.request("ping");

  const start = Date.now();
  await c.stop();
  const elapsed = Date.now() - start;

  // Must complete well before a hang would be indistinguishable from a
  // real deadlock, and comfortably above the fixture's SIGTERM-ignoring
  // grace window so this isn't a flaky race.
  expect(elapsed).toBeLessThan(5_000);
});

test("request() rejects once stopped and does not spawn a new child", async () => {
  const c = make();
  await c.request("ping");
  await c.stop();

  await expect(c.request("ping")).rejects.toThrow(/stopped/);
});

test("id:null error responses (bad-JSON style) are attributed to the sole in-flight request", async () => {
  const c = make();
  await expect(c.request("bad_json_style_error")).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: expect.stringContaining("bad json"),
  });
});

test("id:null error responses are surfaced as an event, not silently dropped, when unattributable", async () => {
  const c = make({ requestTimeoutMs: 500 });
  const unattributed: unknown[] = [];
  c.on("unattributed-error", (err) => unattributed.push(err));

  // Two requests in flight: an id:null error response cannot be safely
  // attributed to either one, so both must be left pending (not silently
  // resolved/rejected with the wrong outcome) while the error is
  // surfaced separately via the event instead of being dropped.
  const a = c.request("silent");
  const b = c.request("bad_json_style_error");

  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(unattributed).toHaveLength(1);
  expect(unattributed[0]).toMatchObject({ code: "BAD_REQUEST" });

  // Neither request was resolved/rejected by the unattributed error --
  // both are still genuinely pending and only settle via their own
  // per-request timeout, proving the error truly wasn't misattributed.
  await expect(a).rejects.toThrow(/timed out/);
  await expect(b).rejects.toThrow(/timed out/);
});
