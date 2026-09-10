import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadConfig, saveConfig } from "../config/store.js";
import { History } from "../db/history.js";
import { openDb } from "../db/schema.js";
import { LoginStatus } from "../helpers/loginStatus.js";
import { NdjsonClient, NdjsonError } from "../helpers/ndjsonClient.js";
import { StateService } from "../state/service.js";
import { buildServer } from "./server.js";

const PASSWORD = "hunter2";
// The built frontend (Task 20). A real dist/ is never present in this test
// tree, so every test that needs a staticRoot points at this minimal stand-in
// instead.
const PUBLIC_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../test/fixtures/public",
);
const validConfig = {
  version: 1, username: "alex", followers: true, followersOrder: "ASC",
  defaults: {}, miner: {},
  streamers: [{ username: "alpha", enabled: true, settings: {} }],
};

let ctx: Awaited<ReturnType<typeof make>>;

async function make() {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  const configPath = join(dir, "config.json");
  // Real directory on disk: the logout route deletes a file from it, and a
  // stub would not prove the pickle actually goes.
  const cookiesDir = join(dir, "cookies");
  mkdirSync(cookiesDir, { recursive: true });
  const history = new History(openDb(":memory:"));
  const supervisor = {
    state: "RUNNING" as const, restart: vi.fn(async () => {}),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    logs: () => ["line one", "line two"], on: vi.fn(),
    // The dashboard's uptime timer ticks from this, so the API has to
    // carry it; a fixed value keeps the assertions exact.
    runningSince: 1_700_000_000_000 as number | null,
    // The header's process stats are read for this pid. It is the test
    // runner's own pid so the route reads a real, live /proc entry.
    livePids: () => [process.pid],
  };
  const client = {
    request: vi.fn(async () => ({ streamers: [] })),
    restart: vi.fn(async () => {}),
    on: vi.fn(),
  };
  const state = new StateService({
    client: client as never, history, getStreamers: () => ["alpha"],
  });
  // A real emitter, not a stub with `on: vi.fn()`: the server subscribes to
  // "progress" and a test needs to drive that path (a successful login
  // clears a stale error and recycles the helper).
  const loginRunner = Object.assign(new EventEmitter(), {
    current: null, start: vi.fn(), cancel: vi.fn(),
  });
  const loginStatus = new LoginStatus();
  const app = buildServer({
    configPath,
    password: PASSWORD,
    doorbellToken: "doorbell-token",
    supervisor: supervisor as never,
    stateService: state,
    history,
    helper: client as never,
    loginRunner: loginRunner as never,
    loginStatus,
    cookiesDir,
    staticRoot: PUBLIC_ROOT,
  });
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/api/session", payload: { password: PASSWORD },
  });
  return {
    app, supervisor, client, history, state, loginRunner, loginStatus, configPath,
    cookiesDir,
    cookie: login.cookies[0].value,
  };
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

// C1: a fresh install's `GET /api/config` (the unedited DEFAULT_CONFIG,
// `username: ""`) must be a value the API accepts back unchanged, or the
// documented first run (unlock -> sign in -> add streamers -> Apply &
// Restart) is unreachable through the UI -- the only way in would be
// hand-editing config.json, exactly what this project exists to eliminate.
// This must fail against the original code, where usernameSchema required
// 4-25 chars and DEFAULT_CONFIG.username was "": PUT of the untouched
// defaults (even with a streamer added, as a real first run would) came
// back 400 and config.json was never created.
test("GET-then-PUT round trip on a fresh install's default config succeeds", async () => {
  const got = await ctx.app.inject({ method: "GET", url: "/api/config", cookies: auth() });
  expect(got.statusCode).toBe(200);
  const fresh = got.json();
  expect(fresh.username).toBe("");

  const firstRun = { ...fresh, streamers: [{ username: "alpha", enabled: true, settings: {} }] };
  const put = await ctx.app.inject({
    method: "PUT", url: "/api/config", cookies: auth(), payload: firstRun,
  });
  expect(put.statusCode).toBe(200);
  expect(put.json().pending).toBe(true);
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
  ctx.loginStatus.markLoggedIn();
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

test("POST /api/config/apply saves without starting the miner when logged out", async () => {
  // index.ts guards its own boot-time start with `loggedIn && username`.
  // Apply had no such guard, so saving a username from the sign-in screen
  // (which must happen *before* login) started a miner with no session
  // behind it and parked it in CRASHED.
  await ctx.app.inject({
    method: "PUT", url: "/api/config", cookies: auth(), payload: validConfig,
  });
  const res = await ctx.app.inject({
    method: "POST", url: "/api/config/apply", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.supervisor.restart).not.toHaveBeenCalled();
  const saved = await ctx.app.inject({ method: "GET", url: "/api/config", cookies: auth() });
  expect(saved.json().username).toBe("alex");
});

test("POST /api/config/apply does not start a miner without a username", async () => {
  ctx.loginStatus.markLoggedIn();
  await ctx.app.inject({
    method: "PUT", url: "/api/config", cookies: auth(),
    payload: { ...validConfig, username: "", streamers: [] },
  });
  const res = await ctx.app.inject({
    method: "POST", url: "/api/config/apply", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.supervisor.restart).not.toHaveBeenCalled();
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

test("GET /api/status carries process stats for the live miner", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  // Read from the test runner's own pid, so this asserts a real /proc
  // read rather than a fixture: any live process has resident memory.
  expect(res.json().stats.rssBytes).toBeGreaterThan(0);
});

test("GET /api/status reports the app version for the sidebar readout", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  // Resolved from APP_VERSION or the workspace manifest; either way it is
  // a non-empty string, never undefined -- the sidebar hides the readout
  // on a missing value, so an absent field would fail silently.
  expect(typeof res.json().version).toBe("string");
  expect(res.json().version).not.toBe("");
});

test("GET /api/status reports no stats when no miner is running", async () => {
  ctx.supervisor.livePids = () => [];
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  // The header hides the readout on null rather than rendering a zero,
  // which would look like a live miner using no CPU.
  expect(res.json().stats).toBeNull();
});

test("GET /api/status derives loginRequired when no Twitch account is set up", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(res.json().loginRequired).toBe(true);
});

// --- loginRequired reflects LoginStatus, not loginRunner.current (I3) ---
// `loginRunner.current` is the progress of a login attempt made by *this*
// process: it reads null (-> loginRequired) for a genuinely logged-in user
// after every restart, and stays "ok" forever once any attempt succeeded in-
// process, even long after the session it produced expired. These prove
// the status now used instead answers both cases correctly.

test("a session established before this process started is not reported as loginRequired", async () => {
  saveConfig(ctx.configPath, validConfig as never);
  // No login was ever attempted in this process -- loginRunner.current is
  // still null, exactly as after a real restart -- but the boot check_login
  // (simulated here by marking loginStatus directly, as index.ts would)
  // found a usable session.
  ctx.loginStatus.markLoggedIn();
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(res.json().loginRequired).toBe(false);
});

test("an AUTH error from the state helper flips loginRequired back on", async () => {
  saveConfig(ctx.configPath, validConfig as never);
  ctx.loginStatus.markLoggedIn();
  const before = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(before.json().loginRequired).toBe(false);

  ctx.state.emit("auth-error", new NdjsonError("session dead", "AUTH"));

  const after = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(after.json().loginRequired).toBe(true);
});

test("an unattributed AUTH error from the helper flips loginRequired back on", async () => {
  saveConfig(ctx.configPath, validConfig as never);
  ctx.loginStatus.markLoggedIn();

  const onCall = ctx.client.on.mock.calls.find(([event]) => event === "unattributed-error");
  expect(onCall).toBeDefined();
  const handler = onCall![1] as (error: unknown) => void;
  handler(new NdjsonError("session dead", "AUTH"));

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
    ["GET", "/api/events"],
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

// --- Doorbell message ---------------------------------------------------
// Free text, unlike the event name, so it is sanitised rather than
// pattern-matched, and never costs us the event it arrived with.

test("doorbell stores the miner's message alongside the event", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "doorbell-token" },
    payload: { event: "GAIN_FOR_CLAIM", ts: 1, message: "+50 -> forsen" },
  });
  expect(res.statusCode).toBe(204);
  expect(ctx.history.recentEvents(1)[0].message).toBe("+50 -> forsen");
});

test("doorbell stores null when no message is sent", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "doorbell-token" },
    payload: { event: "BONUS_CLAIM", ts: 1 },
  });
  expect(res.statusCode).toBe(204);
  expect(ctx.history.recentEvents(1)[0].message).toBe(null);
});

test("doorbell strips control characters from the message", async () => {
  await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "doorbell-token" },
    payload: {
      event: "BET_WIN", ts: 1,
      message: "\u001b[32m+50 forsen\u001b[0m\nrecap line",
    },
  });
  expect(ctx.history.recentEvents(1)[0].message).toBe("+50 forsen recap line");
});

test("doorbell truncates an over-long message", async () => {
  await ctx.app.inject({
    method: "POST", url: "/internal/doorbell",
    headers: { "x-doorbell-token": "doorbell-token" },
    payload: { event: "BET_WIN", ts: 1, message: "x".repeat(5000) },
  });
  expect(ctx.history.recentEvents(1)[0].message).toHaveLength(500);
});

test("doorbell keeps the event when the message is unusable", async () => {
  // The type is what drives the refresh, so a bad message degrades to null
  // rather than dropping the event on the floor with a 400.
  for (const message of [{ evil: true }, 42, "   "]) {
    const res = await ctx.app.inject({
      method: "POST", url: "/internal/doorbell",
      headers: { "x-doorbell-token": "doorbell-token" },
      payload: { event: "STREAMER_ONLINE", ts: 1, message },
    });
    expect(res.statusCode).toBe(204);
    const [latest] = ctx.history.recentEvents(1);
    expect([latest.type, latest.message]).toEqual(["STREAMER_ONLINE", null]);
  }
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

test("a recorded event is pushed to SSE clients instead of waiting for a poll", async () => {
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, {
    headers: { cookie: `session=${ctx.cookie}` },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  await reader.read(); // ": connected"

  const seen = reader.read();
  ctx.state.emit("event", { ts: 2000, type: "GAIN_FOR_CLAIM", message: "+50 -> forsen" });
  const frame = new TextDecoder().decode((await seen).value);
  expect(frame).toContain("event: event");
  expect(frame).toContain('"message":"+50 -> forsen"');

  controller.abort();
});

// --- Shutdown with an attached SSE client (I4) --------------------------
// Node's http.Server#close() waits for every open connection to end
// before its callback fires. A hijacked /api/stream socket never ends on
// its own, so with a browser tab open, app.close() hung indefinitely --
// process.exit(0) in index.ts's SIGTERM handler never ran, and the
// container was SIGKILLed on every deploy that had a dashboard open.
// Deliberately does not abort the client before closing: the whole point
// is a still-open connection, exactly as a live browser tab leaves it.

test("app.close() completes promptly even with an SSE client still attached", async () => {
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const address = ctx.app.server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`, {
    headers: { cookie: `session=${ctx.cookie}` },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  // Drain the initial frame so the connection is fully established, not
  // mid-handshake, before closing.
  await res.body!.getReader().read();

  const closed = ctx.app.close().then(() => "closed" as const);
  const timedOut = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), 3_000);
  });
  expect(await Promise.race([closed, timedOut])).toBe("closed");

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
    helper, loginRunner: loginRunner as never, loginStatus: new LoginStatus(),
    cookiesDir: join(dir, "cookies"),
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

// --- Serving the built frontend (Task 20) -------------------------------
// buildServer only mounts @fastify/static and the SPA fallback when
// staticRoot is set; `make()` now points it at test/fixtures/public, a
// minimal stand-in for apps/frontend/dist so these run without a real build
// on disk.

test("GET /api/status requires a session and returns 401 without one", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/status" });
  expect(res.statusCode).toBe(401);
});

test("an authenticated GET /api/status carries the miner state", async () => {
  const res = await ctx.app.inject({
    method: "GET", url: "/api/status", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().miner).toBe("RUNNING");
});

test("a non-API path serves the SPA's index.html", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/streamers" });
  expect(res.statusCode).toBe(200);
  expect(res.body).toContain('<div id="root">');
});

test("unknown API paths 404 as JSON rather than falling back to the SPA", async () => {
  const res = await ctx.app.inject({
    method: "GET", url: "/api/nonexistent", cookies: auth(),
  });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "not found" });
});

// --- Not-found handler must decode before matching (Correction 2) ------
// The auth hook reads request.routeOptions.url, which find-my-way has
// already percent-decoded. A 404 handler runs precisely because nothing
// matched, so there is no routeOptions.url here -- only the raw request.url
// off the wire. Testing that raw string for an "/api/" prefix repeats the
// bug the auth hook was fixed for: "/%61pi/nope" decodes to "/api/nope" but
// does not start with "/api/" unless decoded first, so it would wrongly
// fall through to the SPA and hand an API client an HTML body instead of a
// JSON 404.

test("an encoded API path still 404s as JSON instead of falling back to the SPA", async () => {
  const res = await ctx.app.inject({
    method: "GET", url: "/%61pi/nope", cookies: auth(),
  });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "not found" });
});

test("a malformed percent-escape in the path never reaches our handler as a crash", async () => {
  // decodeURIComponent("/%") throws -- the handler's try/catch guards
  // against that reaching our code. In practice, with routes registered,
  // Fastify's own router (find-my-way) already rejects a URL it cannot
  // decode with FST_ERR_BAD_URL before dispatch ever reaches our
  // notFoundHandler, so this case never gets far enough to exercise our
  // catch over a real request -- confirmed by the "NOTFOUND HANDLER HIT"
  // vs. FST_ERR_BAD_URL difference between a route-less and a routed app.
  // The assertion that matters here is the one that is actually reachable:
  // a malformed escape is answered with a clean 400, not an unhandled
  // exception or a 500.
  const res = await ctx.app.inject({ method: "GET", url: "/%", cookies: auth() });
  expect(res.statusCode).toBe(400);
});

test("GET /api/status reports when the running miner started", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(res.json().startedAt).toBe(1_700_000_000_000);
});

test("GET /api/status reports a null start time when no miner is running", async () => {
  ctx.supervisor.runningSince = null;
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(res.json().startedAt).toBeNull();
});

test("POST /api/miner/start answers with the state and start time", async () => {
  const res = await ctx.app.inject({ method: "POST", url: "/api/miner/start", cookies: auth() });
  expect(ctx.supervisor.start).toHaveBeenCalled();
  expect(res.json()).toEqual({ state: "RUNNING", startedAt: 1_700_000_000_000 });
});

test("POST /api/miner/stop answers with the state and start time", async () => {
  ctx.supervisor.runningSince = null;
  const res = await ctx.app.inject({ method: "POST", url: "/api/miner/stop", cookies: auth() });
  expect(ctx.supervisor.stop).toHaveBeenCalled();
  expect(res.json()).toEqual({ state: "RUNNING", startedAt: null });
});

test("GET /api/events returns recent events newest first", async () => {
  ctx.history.recordEvent("STREAMER_ONLINE", 1000, "forsen is now streaming");
  ctx.history.recordEvent("GAIN_FOR_CLAIM", 2000, "+50 -> forsen");
  const response = await ctx.app.inject({
    method: "GET", url: "/api/events", cookies: auth(),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().events).toEqual([
    { ts: 2000, type: "GAIN_FOR_CLAIM", message: "+50 -> forsen" },
    { ts: 1000, type: "STREAMER_ONLINE", message: "forsen is now streaming" },
  ]);
});

// -- POST /api/twitch/logout ------------------------------------------------
// Until this existed there was no way to drop a Twitch session short of
// deleting the pickle by hand on the host: the UI could start a login but
// never end one, so a wrong account or a session under test was stuck.

/** Writes the pickle the logout route is expected to delete. */
function seedCookie(username = "alex"): string {
  saveConfig(ctx.configPath, {
    version: 1, username, followers: true, followersOrder: "ASC",
    defaults: {}, miner: {},
    streamers: [{ username: "alpha", enabled: true, settings: {} }],
  });
  const file = join(ctx.cookiesDir, `${username}.pkl`);
  writeFileSync(file, "pickled-session");
  return file;
}

test("logging out of Twitch deletes the stored cookie pickle", async () => {
  const file = seedCookie();
  const response = await ctx.app.inject({
    method: "POST", url: "/api/twitch/logout", cookies: auth(),
  });
  expect(response.statusCode).toBe(200);
  expect(existsSync(file)).toBe(false);
});

test("logging out reports the Twitch session as needing sign-in again", async () => {
  seedCookie();
  ctx.loginStatus.markLoggedIn();
  await ctx.app.inject({ method: "POST", url: "/api/twitch/logout", cookies: auth() });
  expect(ctx.loginStatus.required).toBe(true);
});

test("logging out stops the miner first", async () => {
  // The miner holds the session in memory and rewrites the pickle when it
  // refreshes the token, so deleting the file under a live miner either
  // resurrects it or leaves the miner mining as the account just dropped.
  seedCookie();
  await ctx.app.inject({ method: "POST", url: "/api/twitch/logout", cookies: auth() });
  expect(ctx.supervisor.stop).toHaveBeenCalled();
});

test("logging out recycles the state helper", async () => {
  // helpers/_session.py freezes the pickle path at spawn and reload_cookies()
  // re-reads that same frozen path, so a helper left running keeps answering
  // from the session it already loaded -- the dashboard would go on looking
  // signed in against a cookie that no longer exists.
  seedCookie();
  await ctx.app.inject({ method: "POST", url: "/api/twitch/logout", cookies: auth() });
  expect(ctx.client.restart).toHaveBeenCalled();
});

test("logging out twice is not an error", async () => {
  // The pickle is already gone the second time. Reporting that as a failure
  // would leave the UI showing an error for the state the user asked for.
  seedCookie();
  await ctx.app.inject({ method: "POST", url: "/api/twitch/logout", cookies: auth() });
  const second = await ctx.app.inject({
    method: "POST", url: "/api/twitch/logout", cookies: auth(),
  });
  expect(second.statusCode).toBe(200);
});

test("logging out keeps the username, so signing back in needs no retyping", async () => {
  seedCookie();
  await ctx.app.inject({ method: "POST", url: "/api/twitch/logout", cookies: auth() });
  expect(loadConfig(ctx.configPath).username).toBe("alex");
});

test("logging out of Twitch requires a session", async () => {
  seedCookie();
  const response = await ctx.app.inject({ method: "POST", url: "/api/twitch/logout" });
  expect(response.statusCode).toBe(401);
});

test("a successful login clears a stale error from the signed-out session", async () => {
  // A refresh already in flight when the user signs in is answered by the
  // old, signed-out helper, so its 401 lands after the login succeeded and
  // arrives classified GQL rather than AUTH -- the raw traceback then sat
  // on the dashboard until an unrelated refresh happened to succeed.
  ctx.client.request.mockRejectedValueOnce(
    new NdjsonError("GQL Operation 'ChannelPointsContext' failed all 3 attempts", "GQL"),
  );
  saveConfig(ctx.configPath, {
    version: 1, username: "alex", followers: true, followersOrder: "ASC",
    defaults: {}, miner: {},
    streamers: [{ username: "alpha", enabled: true, settings: {} }],
  });
  await ctx.state.refresh();
  expect(ctx.state.snapshot().error).not.toBeNull();

  // Every later refresh hangs, so the error can only be cleared by the
  // login handler itself -- not by a recycle's refresh happening to
  // succeed, which is the slow path that left the traceback on screen for
  // seconds in the first place.
  ctx.client.request.mockImplementation(() => new Promise(() => {}));

  ctx.loginRunner.emit("progress", { stage: "ok", username: "alex" });

  await vi.waitFor(() => expect(ctx.state.snapshot().error).toBeNull());
});

test("a successful login starts the miner", async () => {
  // The apply path's comment has always said the miner "is started by the
  // login flow once a session exists", but nothing there ever started it.
  // Harmless while a first login was always followed by an apply -- and
  // then logging out of Twitch was added, which stops the miner, so a
  // logout/login round trip left it stopped with no hint why.
  saveConfig(ctx.configPath, {
    version: 1, username: "alex", followers: true, followersOrder: "ASC",
    defaults: {}, miner: {},
    streamers: [{ username: "alpha", enabled: true, settings: {} }],
  });

  ctx.loginRunner.emit("progress", { stage: "ok", username: "alex" });

  await vi.waitFor(() => expect(ctx.supervisor.restart).toHaveBeenCalled());
});

test("a failed login leaves the miner alone", async () => {
  ctx.loginRunner.emit("progress", { stage: "error", error: "token rejected" });
  await Promise.resolve();
  expect(ctx.supervisor.restart).not.toHaveBeenCalled();
});
