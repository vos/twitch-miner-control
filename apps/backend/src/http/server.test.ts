import { EventEmitter, once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadConfig, saveConfig } from "../config/store.js";
import { History } from "../db/history.js";
import { openDb } from "../db/schema.js";
import { NdjsonClient } from "../helpers/ndjsonClient.js";
import { StateService } from "../state/service.js";
import { buildServer } from "./server.js";

const PASSWORD = "hunter2";
const validConfig = {
  version: 1, username: "alex", followers: true, followersOrder: "ASC",
  defaults: {}, streamers: [{ username: "alpha", enabled: true, settings: {} }],
};

let ctx: Awaited<ReturnType<typeof make>>;

async function make() {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  const history = new History(openDb(":memory:"));
  const supervisor = {
    state: "RUNNING" as const, restart: vi.fn(async () => {}),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    logs: () => ["line one", "line two"], on: vi.fn(),
  };
  const client = {
    request: vi.fn(async () => ({ streamers: [] })),
    restart: vi.fn(async () => {}),
  };
  const state = new StateService({
    client: client as never, history, getStreamers: () => ["alpha"],
  });
  const loginRunner = { current: null, start: vi.fn(), on: vi.fn(), cancel: vi.fn() };
  const app = buildServer({
    configPath: join(dir, "config.json"),
    password: PASSWORD,
    doorbellToken: "doorbell-token",
    supervisor: supervisor as never,
    stateService: state,
    history,
    helper: client as never,
    loginRunner: loginRunner as never,
  });
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/api/session", payload: { password: PASSWORD },
  });
  return { app, supervisor, client, history, state, loginRunner, cookie: login.cookies[0].value };
}

beforeEach(async () => { ctx = await make(); });

// Every test builds its own server; without this the debounce timer a
// doorbell ring arms would outlive the test that armed it.
afterEach(async () => {
  ctx.state.stop();
  await ctx.app.close();
});

const auth = () => ({ session: ctx.cookie });

test("GET /api/config returns defaults before anything is saved", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/config", cookies: auth() });
  expect(res.statusCode).toBe(200);
  expect(res.json().streamers).toEqual([]);
});

test("PUT /api/config stages without restarting the miner", async () => {
  const res = await ctx.app.inject({
    method: "PUT", url: "/api/config", cookies: auth(), payload: validConfig,
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.supervisor.restart).not.toHaveBeenCalled();
  expect(res.json().pending).toBe(true);
});

test("PUT /api/config rejects an invalid config with 400", async () => {
  const res = await ctx.app.inject({
    method: "PUT", url: "/api/config", cookies: auth(),
    payload: { ...validConfig, streamers: [{ username: "!!", enabled: true, settings: {} }] },
  });
  expect(res.statusCode).toBe(400);
});

test("POST /api/config/apply writes the config and restarts", async () => {
  await ctx.app.inject({
    method: "PUT", url: "/api/config", cookies: auth(), payload: validConfig,
  });
  const res = await ctx.app.inject({
    method: "POST", url: "/api/config/apply", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.supervisor.restart).toHaveBeenCalledOnce();
  const saved = await ctx.app.inject({ method: "GET", url: "/api/config", cookies: auth() });
  expect(saved.json().streamers[0].username).toBe("alpha");
});

test("POST /api/config/apply with nothing staged does not restart", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/api/config/apply", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.supervisor.restart).not.toHaveBeenCalled();
});

test("GET /api/status reports supervisor state and staleness", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(res.json()).toMatchObject({ miner: "RUNNING", stale: true });
});

test("GET /api/status derives loginRequired when no Twitch account is set up", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(res.json().loginRequired).toBe(true);
});

test("POST /api/miner/restart delegates to the supervisor", async () => {
  await ctx.app.inject({ method: "POST", url: "/api/miner/restart", cookies: auth() });
  expect(ctx.supervisor.restart).toHaveBeenCalledOnce();
});

test("GET /api/logs returns the ring buffer", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/logs", cookies: auth() });
  expect(res.json().lines).toEqual(["line one", "line two"]);
});

test("GET /api/streamers/lookup proxies to the helper", async () => {
  ctx.client.request.mockResolvedValueOnce({
    username: "alpha", channelId: "42", exists: true,
  } as never);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/streamers/lookup?q=alpha", cookies: auth(),
  });
  expect(res.json().exists).toBe(true);
});

test("GET /api/streamers/lookup rejects a malformed username without calling Twitch", async () => {
  const before = ctx.client.request.mock.calls.length;
  const res = await ctx.app.inject({
    method: "GET", url: "/api/streamers/lookup?q=a", cookies: auth(),
  });
  expect(res.statusCode).toBe(400);
  expect(ctx.client.request.mock.calls.length).toBe(before);
});

test("GET /api/history returns a series", async () => {
  ctx.history.recordPoints("alpha", 10, 1000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().series).toEqual([{ ts: 1000, balance: 10 }]);
});

// --- Query validation (Correction 3) -----------------------------------
// An unvalidated `streamer` binds `undefined` into better-sqlite3, which
// throws -- a 500 on a malformed query instead of a 400.

test("GET /api/history without a streamer is a 400, not a 500", async () => {
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?from=0&to=99999", cookies: auth(),
  });
  expect(res.statusCode).toBe(400);
});

test("GET /api/history rejects a malformed streamer name", async () => {
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=!!&from=0&to=99999", cookies: auth(),
  });
  expect(res.statusCode).toBe(400);
});

test("GET /api/history rejects a non-numeric range", async () => {
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=abc&to=xyz", cookies: auth(),
  });
  expect(res.statusCode).toBe(400);
});

test("GET /api/history rejects a missing range rather than binding NaN", async () => {
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha", cookies: auth(),
  });
  expect(res.statusCode).toBe(400);
});

// --- Auth topology (Correction 1) --------------------------------------
// registerAuth installs its onRequest hook inside an encapsulated scope, so
// a protected route registered at the root would skip the hook entirely.
// These assert the guard as assembled by buildServer, not in a fixture.

test("a protected route returns 401 without a session cookie", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/config" });
  expect(res.statusCode).toBe(401);
  expect(ctx.supervisor.restart).not.toHaveBeenCalled();
});

test("every protected route is inside the auth scope", async () => {
  const routes: Array<[string, string]> = [
    ["GET", "/api/config"],
    ["PUT", "/api/config"],
    ["POST", "/api/config/apply"],
    ["GET", "/api/status"],
    ["GET", "/api/streamers"],
    ["GET", "/api/followers"],
    ["GET", "/api/streamers/lookup?q=alpha"],
    ["GET", "/api/history?streamer=alpha&from=0&to=1"],
    ["GET", "/api/logs"],
    ["GET", "/api/stream"],
    ["POST", "/api/miner/start"],
    ["POST", "/api/miner/stop"],
    ["POST", "/api/miner/restart"],
    ["POST", "/api/twitch/login"],
  ];
  for (const [method, url] of routes) {
    const res = await ctx.app.inject({ method: method as "GET", url });
    expect([method, url, res.statusCode]).toEqual([method, url, 401]);
  }
  expect(ctx.supervisor.restart).not.toHaveBeenCalled();
  expect(ctx.supervisor.start).not.toHaveBeenCalled();
  expect(ctx.loginRunner.start).not.toHaveBeenCalled();
});

// --- Doorbell -----------------------------------------------------------

test("doorbell with the right token rings the state service", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "doorbell-token" },
    payload: { event: "STREAMER_ONLINE", ts: 1 },
  });
  expect(res.statusCode).toBe(204);
  expect(ctx.history.recentEvents(1)[0].type).toBe("STREAMER_ONLINE");
});

test("doorbell with a wrong token is rejected", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "nope" },
    payload: { event: "STREAMER_ONLINE", ts: 1 },
  });
  expect(res.statusCode).toBe(403);
});

test("doorbell needs no session cookie", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "doorbell-token" },
    payload: { event: "GAIN_FOR_CLAIM", ts: 1 },
  });
  expect(res.statusCode).toBe(204);
});

// --- Doorbell payload validation (Correction 4) -------------------------
// `event` is written straight into the events table. The real doorbell only
// ever sends short upper-snake-case names (python/helpers/doorbell.py).

test("doorbell rejects an over-long event name", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "doorbell-token" },
    payload: { event: "A".repeat(5000), ts: 1 },
  });
  expect(res.statusCode).toBe(400);
  expect(ctx.history.recentEvents(1)).toEqual([]);
});

test("doorbell rejects an event name that is not upper snake case", async () => {
  for (const event of ["streamer online", "<script>", "", "Events.STREAMER_ONLINE"]) {
    const res = await ctx.app.inject({
      method: "POST", url: "/internal/doorbell",
      headers: { "x-doorbell-token": "doorbell-token" },
      payload: { event, ts: 1 },
    });
    expect([event, res.statusCode]).toEqual([event, 400]);
  }
  expect(ctx.history.recentEvents(1)).toEqual([]);
});

test("doorbell rejects a non-string event", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "doorbell-token" },
    payload: { event: { evil: true }, ts: 1 },
  });
  expect(res.statusCode).toBe(400);
  expect(ctx.history.recentEvents(1)).toEqual([]);
});

test("doorbell checks the token before it looks at the body", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "nope" },
    payload: { event: "A".repeat(5000), ts: 1 },
  });
  expect(res.statusCode).toBe(403);
  expect(ctx.history.recentEvents(1)).toEqual([]);
});

// --- SSE (Correction 4) -------------------------------------------------
// The stream handler hijacks the reply, and it lives inside the auth scope
// alongside registerAuth's onRequest hook. Exercised over a real socket:
// inject() cannot drive a hijacked, never-ending response.

test("an authenticated SSE client connects and receives broadcasts", async () => {
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, {
    headers: { cookie: `session=${ctx.cookie}` },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");

  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain(": connected");

  const seen = reader.read();
  ctx.state.emit("change", { streamers: [], lastUpdated: 7, stale: false, error: null });
  const frame = new TextDecoder().decode((await seen).value);
  expect(frame).toContain("event: state");
  expect(frame).toContain('"lastUpdated":7');

  controller.abort();
});

test("an SSE client with no session cookie is refused", async () => {
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`);
  expect(res.status).toBe(401);
  await res.text();
});

// --- Helper recycling (fix round 1, Important 1) ------------------------
// The state helper is spawned once and kept for the process lifetime.
// python/helpers/_session.py freezes `cookies_file` as `{username}.pkl` at
// build time and reload_cookies() re-reads that same fixed path, so a
// helper spawned before the Twitch username was known reads `cookies/.pkl`
// forever. index.ts's live TWITCH_USERNAME accessor only helps a process
// that is about to be spawned -- the long-lived one has to be replaced.
//
// These use a real NdjsonClient over the echo fixture, whose `whoami` op
// reports the environment its own process was spawned with, so they prove
// a new OS process actually saw the new username.

const helperFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/echo-helper.mjs",
);

async function makeLive() {
  const dir = mkdtempSync(join(tmpdir(), "srv-live-"));
  const configPath = join(dir, "config.json");
  const history = new History(openDb(":memory:"));
  // Exactly the accessor index.ts installs: the username is read from the
  // config file at each spawn, never snapshotted.
  const env: Record<string, string> = {};
  Object.defineProperty(env, "TWITCH_USERNAME", {
    enumerable: true,
    get: () => loadConfig(configPath).username,
  });
  const helper = new NdjsonClient({
    command: process.execPath, args: [helperFixture], cwd: dir, env,
  });
  // Empty streamer list: the post-recycle refresh then completes without
  // sending anything to the fixture, keeping these tests about identity.
  const state = new StateService({ client: helper, history, getStreamers: () => [] });
  const supervisor = {
    state: "RUNNING" as const, restart: vi.fn(async () => {}),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    logs: () => [], on: vi.fn(),
  };
  const loginRunner = Object.assign(new EventEmitter(), {
    current: null, start: vi.fn(), cancel: vi.fn(),
  });
  const app = buildServer({
    configPath, password: PASSWORD, doorbellToken: "doorbell-token",
    supervisor: supervisor as never, stateService: state, history,
    helper, loginRunner: loginRunner as never,
  });
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/api/session", payload: { password: PASSWORD },
  });
  return {
    app, helper, state, loginRunner, configPath,
    cookies: { session: login.cookies[0].value },
    async dispose() {
      state.stop();
      await helper.stop();
      await app.close();
    },
  };
}

/** Waits for the client to report its child gone, with a legible timeout. */
async function afterRespawn(helper: NdjsonClient, trigger: () => void): Promise<void> {
  const respawned = once(helper, "respawn");
  trigger();
  let timer: NodeJS.Timeout;
  await Promise.race([
    respawned,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("the state helper was never recycled")),
        2000,
      );
    }),
  ]).finally(() => clearTimeout(timer!));
}

test("a successful login recycles the state helper against the current username", async () => {
  const t = await makeLive();
  try {
    await expect(t.helper.request("whoami")).resolves.toMatchObject({ username: "" });
    // The username reached the config while the helper was already up.
    saveConfig(t.configPath, validConfig as never);
    await afterRespawn(t.helper, () => {
      t.loginRunner.emit("progress", { stage: "ok", username: "alex" });
    });
    await expect(t.helper.request("whoami")).resolves.toMatchObject({
      username: "alex",
    });
  } finally {
    await t.dispose();
  }
});

test("a failed login does not recycle the state helper", async () => {
  const t = await makeLive();
  try {
    const before = (await t.helper.request("whoami")) as { pid: number };
    t.loginRunner.emit("progress", { stage: "error", error: "token rejected" });
    t.loginRunner.emit("progress", { stage: "pending" });
    const after = (await t.helper.request("whoami")) as { pid: number };
    expect(after.pid).toBe(before.pid);
  } finally {
    await t.dispose();
  }
});

test("applying a config recycles the state helper against the new username", async () => {
  const t = await makeLive();
  try {
    await expect(t.helper.request("whoami")).resolves.toMatchObject({ username: "" });
    await t.app.inject({
      method: "PUT", url: "/api/config", cookies: t.cookies, payload: validConfig,
    });
    const res = await t.app.inject({
      method: "POST", url: "/api/config/apply", cookies: t.cookies,
    });
    expect(res.statusCode).toBe(200);
    // apply() awaits the recycle, so no polling is needed here.
    await expect(t.helper.request("whoami")).resolves.toMatchObject({
      username: "alex",
    });
  } finally {
    await t.dispose();
  }
});

test("an apply with nothing staged leaves the state helper alone", async () => {
  const t = await makeLive();
  try {
    const before = (await t.helper.request("whoami")) as { pid: number };
    await t.app.inject({
      method: "POST", url: "/api/config/apply", cookies: t.cookies,
    });
    const after = (await t.helper.request("whoami")) as { pid: number };
    expect(after.pid).toBe(before.pid);
  } finally {
    await t.dispose();
  }
});
