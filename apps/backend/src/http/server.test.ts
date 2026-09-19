import { EventEmitter, once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadConfig, saveConfig } from "../config/store.js";
import { History } from "../db/history.js";
import { openDb } from "../db/schema.js";
import { Streamers } from "../db/streamers.js";
import { LoginStatus } from "../helpers/loginStatus.js";
import { NdjsonClient, NdjsonError } from "../helpers/ndjsonClient.js";
import { CampaignCatalogue, type Campaign } from "../state/campaignCatalogue.js";
import { InventoryCache } from "../state/inventory.js";
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

async function make(options: {
  statusTickMs?: number;
  appLog?: {
    buffer: { entries: () => unknown[]; total: number };
    onEvent: (listener: (event: unknown) => void) => void;
  };
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "srv-"));
  const configPath = join(dir, "config.json");
  // Real directory on disk: the logout route deletes a file from it, and a
  // stub would not prove the pickle actually goes.
  const cookiesDir = join(dir, "cookies");
  mkdirSync(cookiesDir, { recursive: true });
  const db = openDb(":memory:");
  const history = new History(db);
  const streamers = new Streamers(db);
  // A real emitter: a test drives its "state" event to check the status push.
  const supervisor = Object.assign(new EventEmitter(), {
    state: "RUNNING" as const, restart: vi.fn(async () => {}),
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    logs: () => ({ lines: ["line one", "line two"], total: 2 }),
    // The dashboard's uptime timer ticks from this, so the API has to
    // carry it; a fixed value keeps the assertions exact.
    runningSince: 1_700_000_000_000 as number | null,
    // The header's process stats are read for this pid. It is the test
    // runner's own pid so the route reads a real, live /proc entry.
    livePids: () => [process.pid],
  });
  // Routed by op: the campaign routes drive two caches through this same
  // client, and a blanket `{ streamers: [] }` would hand them the wrong
  // shape. `helperResponses` lets a test override one op.
  const helperResponses: Record<string, unknown> = {
    inventory: { inventory: {} },
  };
  // What the campaign source yields; a test may swap it, or make it
  // throw to exercise the unavailable path.
  let campaignSource: () => Campaign[] = () => [];
  const setCampaigns = (next: () => Campaign[]) => { campaignSource = next; };
  const client = {
    request: vi.fn(async (op: string) => {
      const canned = helperResponses[op];
      if (canned instanceof Error) throw canned;
      return canned ?? { streamers: [] };
    }),
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
  // Campaigns come from a public tracker over plain HTTPS; progress
  // still comes from Twitch through the helper below.
  const catalogue = new CampaignCatalogue({
    source: async () => campaignSource(),
    path: join(dir, "campaigns.json"),
  });
  const inventory = new InventoryCache({ client: client as never });
  const engine = { pass: vi.fn(async () => {}) };
  const pending = {
    cancel: vi.fn(), fireNow: vi.fn(async () => {}),
    state: () => ({ pending: false, dueAt: null, reason: null }),
  };
  const app = buildServer({
    configPath,
    password: PASSWORD,
    doorbellToken: "doorbell-token",
    supervisor: supervisor as never,
    stateService: state,
    history,
    streamers,
    helper: client as never,
    loginRunner: loginRunner as never,
    loginStatus,
    cookiesDir,
    catalogue,
    inventory,
    engine: engine as never,
    pendingRestart: pending as never,
    staticRoot: PUBLIC_ROOT,
    statusTickMs: options.statusTickMs,
    appLog: options.appLog as never,
  });
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/api/session", payload: { password: PASSWORD },
  });
  return {
    app, supervisor, client, history, streamers, state, loginRunner, loginStatus, configPath,
    cookiesDir, helperResponses, setCampaigns, catalogue, engine, pending,
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

// Null here is the healthy default: nothing has been checked yet in a
// test process, and a release no newer than the running one answers the
// same way. The field must still be present, because its absence is how
// the frontend detects a backend that predates the notice.
test("GET /api/status carries the update notice field", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/status", cookies: auth() });
  expect(res.json()).toHaveProperty("latestVersion");
  expect(res.json().latestVersion).toBeNull();
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
  expect(res.json()).toEqual({ lines: ["line one", "line two"], total: 2 });
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

test("GET /api/history scopes events to the streamer asked for", async () => {
  ctx.history.recordEvent("GAIN_FOR_CLAIM", 1000, "+50", "alpha");
  ctx.history.recordEvent("GAIN_FOR_CLAIM", 2000, "+70", "beta");
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().events).toEqual([
    { ts: 1000, type: "GAIN_FOR_CLAIM", message: "+50" },
  ]);
});

test("GET /api/history reports points earned per stream", async () => {
  ctx.history.openStreamerSession("alpha", "s1", 1000, 100);
  ctx.history.recordPoints("alpha", 180, 4000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().sessions[0].earned).toBe(80);
});

test("GET /api/history leaves earned null when the anchor is unknown", async () => {
  ctx.history.openStreamerSession("alpha", "s1", 1000, null);
  ctx.history.recordPoints("alpha", 180, 4000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().sessions[0].earned).toBeNull();
});

test("GET /api/history floors mined time at our first sighting", async () => {
  // A session back-dated by Twitch's createdAt to before we were watching:
  // the miner being up the whole time must not bill those hours as mined.
  ctx.history.openMinerSession(0);
  ctx.history.openStreamerSession("alpha", "s1", 1000, 100);
  ctx.streamers.see("alpha", 6000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=10000", cookies: auth(),
  });
  const body = res.json();
  expect(body.firstSeen).toBe(6000);
  expect(body.sessions[0].mined).toBe(4000);
  expect(body.coverage.mined).toEqual([{ start: 6000, end: 10000 }]);
});

test("GET /api/history reports the oldest kept sample as the retention floor", async () => {
  ctx.history.recordPoints("alpha", 10, 5000);
  ctx.history.recordPoints("alpha", 20, 9000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=99999", cookies: auth(),
  });
  expect(res.json().retentionFloor).toBe(5000);
});

test("GET /api/history measures the window gain from the balance before it", async () => {
  // The baseline is the balance in force at `from`, which is a sample
  // OUTSIDE the window. Differencing the returned series instead would
  // report 30 here (50 - 20) and lose the step from 10 to 20.
  ctx.history.recordPoints("alpha", 10, 1000);
  ctx.history.recordPoints("alpha", 20, 6000);
  ctx.history.recordPoints("alpha", 50, 8000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=5000&to=9000", cookies: auth(),
  });
  const body = res.json();
  expect(body.gained).toBe(40);
  // A full window: the dialog labels it with the range it asked for.
  expect(body.gainedSince).toBeNull();
});

test("GET /api/history reports the real start of a window it has less history than", async () => {
  // Tracked since 5000 but asked for a window starting at 0: the gain is
  // real over a real span, and gainedSince is what lets the dialog say
  // so rather than claiming the whole range.
  ctx.history.recordPoints("alpha", 10, 5000);
  ctx.history.recordPoints("alpha", 70, 8000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=9000", cookies: auth(),
  });
  const body = res.json();
  expect(body.gained).toBe(60);
  expect(body.gainedSince).toBe(5000);
});

test("GET /api/history leaves the gain null when there is no earlier balance", async () => {
  // One sample, at the very end of the window: there is no elapsed time
  // to have earned anything in, so "+0" would be a confident wrong claim.
  ctx.history.recordPoints("alpha", 10, 9000);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=alpha&from=0&to=9000", cookies: auth(),
  });
  expect(res.json().gained).toBeNull();
});

test("GET /api/history returns empty blocks for an untracked streamer", async () => {
  const res = await ctx.app.inject({
    method: "GET", url: "/api/history?streamer=nobody&from=0&to=99999", cookies: auth(),
  });
  const body = res.json();
  expect(body.series).toEqual([]);
  expect(body.events).toEqual([]);
  expect(body.sessions).toEqual([]);
  expect(body.retentionFloor).toBeNull();
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

/** Opens an authenticated stream on a listening server, past its first frame. */
async function openStream() {
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
  return {
    next: async () => new TextDecoder().decode((await reader.read()).value),
    close: () => controller.abort(),
  };
}

test("pushes the status to SSE clients the moment the miner changes state", async () => {
  const stream = await openStream();
  const seen = stream.next();
  ctx.supervisor.emit("state", "STOPPED");
  const frame = await seen;
  expect(frame).toContain("event: status");
  expect(frame).toContain('"startedAt":1700000000000');
  stream.close();
});

test("pushes new miner output to SSE clients as it is logged", async () => {
  const stream = await openStream();
  const seen = stream.next();
  ctx.supervisor.emit("log", { lines: ["fresh line"], total: 3 });
  const frame = await seen;
  expect(frame).toContain("event: log");
  expect(frame).toContain('{"lines":["fresh line"],"total":3}');
  stream.close();
});

test("pushes the status to SSE clients when the Twitch session is found dead", async () => {
  ctx.loginStatus.markLoggedIn();
  const stream = await openStream();
  const seen = stream.next();
  ctx.state.emit("auth-error");
  const frame = await seen;
  expect(frame).toContain("event: status");
  expect(frame).toContain('"loginRequired":true');
  stream.close();
});

test("keeps SSE clients' process stats current on a tick", async () => {
  ctx.state.stop();
  await ctx.app.close();
  ctx = await make({ statusTickMs: 20 });

  const stream = await openStream();
  // Nothing emitted: this frame can only have come from the tick.
  const frame = await stream.next();
  expect(frame).toContain("event: status");
  expect(frame).toContain('"stats":{');
  stream.close();
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
    logs: () => ({ lines: [], total: 0 }), on: vi.fn(),
  };
  const loginRunner = Object.assign(new EventEmitter(), {
    current: null, start: vi.fn(), cancel: vi.fn(),
  });
  const app = buildServer({
    configPath, password: PASSWORD, doorbellToken: "doorbell-token",
    supervisor: supervisor as never, stateService: state, history,
    helper, loginRunner: loginRunner as never, loginStatus: new LoginStatus(),
    cookiesDir: join(dir, "cookies"),
    // This server never exercises the campaign routes; the caches are
    // here only to satisfy the deps contract.
    catalogue: new CampaignCatalogue({
      source: async () => [], path: join(dir, "campaigns.json"),
    }),
    inventory: new InventoryCache({ client: helper as never }),
    // These servers never exercise the subscription routes; the stubs
    // are here only to satisfy the deps contract.
    engine: { pass: vi.fn(async () => {}) } as never,
    pendingRestart: {
      cancel: vi.fn(), fireNow: vi.fn(async () => {}),
      state: () => ({ pending: false, dueAt: null, reason: null }),
    } as never,
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
    defaults: {}, miner: {}, subscriptions: [],
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
    defaults: {}, miner: {}, subscriptions: [],
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
    defaults: {}, miner: {}, subscriptions: [],
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

test("exposes the live SSE client count", () => {
  // The state service reads this to decide whether a refresh needs its
  // display half, so it has to track the set rather than snapshot it.
  expect(ctx.app.clientCount).toBe(0);
});

test("GET /api/streamers answers from the held snapshot", async () => {
  // The Streamers tab remounts and refetches on every visit, so a round
  // trip here is felt as a multi-second stall each time it is opened.
  await ctx.state.refresh();
  const before = ctx.client.request.mock.calls.length;
  await ctx.app.inject({ method: "GET", url: "/api/streamers", cookies: auth() });
  expect(ctx.client.request.mock.calls.length).toBe(before);
});

test("GET /api/streamers derives first when the backend has been idle", async () => {
  // The one case that must wait: an idle pass left the held copy without
  // its display fields, so serving it directly would render blank cards.
  const idle = new StateService({
    client: ctx.client as never,
    history: ctx.history,
    getStreamers: () => ["alpha"],
    clientsConnected: () => false,
  });
  await idle.refresh();
  expect(idle.needsDerive).toBe(true);

  const app = buildServer({
    configPath: ctx.configPath,
    password: PASSWORD,
    doorbellToken: "doorbell-token",
    supervisor: ctx.supervisor as never,
    stateService: idle,
    history: ctx.history,
    helper: ctx.client as never,
    loginRunner: ctx.loginRunner as never,
    loginStatus: ctx.loginStatus,
    catalogue: new CampaignCatalogue({
      source: async () => [],
      path: join(mkdtempSync(join(tmpdir(), "srv-")), "campaigns.json"),
    }),
    inventory: new InventoryCache({ client: ctx.client as never }),
    // These servers never exercise the subscription routes; the stubs
    // are here only to satisfy the deps contract.
    engine: { pass: vi.fn(async () => {}) } as never,
    pendingRestart: {
      cancel: vi.fn(), fireNow: vi.fn(async () => {}),
      state: () => ({ pending: false, dueAt: null, reason: null }),
    } as never,
    cookiesDir: ctx.cookiesDir,
    staticRoot: PUBLIC_ROOT,
  });
  await app.ready();
  const login = await app.inject({
    method: "POST", url: "/api/session", payload: { password: PASSWORD },
  });
  const before = ctx.client.request.mock.calls.length;
  await app.inject({
    method: "GET", url: "/api/streamers",
    cookies: { session: login.cookies[0].value },
  });
  expect(ctx.client.request.mock.calls.length).toBeGreaterThan(before);

  idle.stop();
  await app.close();
});

const aCampaign = {
  id: "c1",
  name: "Campaign One",
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1_000,
  endsAt: 9_000,
  drops: [
    { id: "d1", name: "Crate",
      benefits: [{ name: "Crate", imageUrl: "https://cdn/crate.png" }],
      requiredMinutes: 60, requiredSubs: 0 },
  ],
};

test("GET /api/campaigns joins the catalogue with viewer progress", async () => {
  ctx.setCampaigns(() => [aCampaign]);
  ctx.helperResponses["inventory"] = {
    inventory: { c1: { d1: { minutes: 30, claimed: false, instanceId: null } } },
  };
  const res = await ctx.app.inject({
    method: "GET", url: "/api/campaigns", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.campaigns[0].drops[0].status).toBe("in-progress");
  expect(body.campaigns[0].drops[0].minutes).toBe(30);
  expect(body.campaigns[0].status).toBe("partial");
});

test("GET /api/campaigns reports the two cache ages separately", async () => {
  // They are on clocks a day apart, so one merged "updated N ago" would
  // describe neither.
  ctx.setCampaigns(() => [aCampaign]);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/campaigns", cookies: auth(),
  });
  const body = res.json();
  expect(typeof body.catalogueFetchedAt).toBe("number");
  expect(typeof body.progressFetchedAt).toBe("number");
  expect(body.catalogueStale).toBe(false);
  expect(body.progressAvailable).toBe(true);
});

test("POST /api/campaigns/refresh refetches progress, not just the catalogue", async () => {
  // The button exists to answer "did the minutes I just watched land?".
  // Refreshing only the catalogue would leave that number untouched.
  ctx.setCampaigns(() => [aCampaign]);
  ctx.helperResponses["inventory"] = { inventory: {} };
  await ctx.app.inject({ method: "GET", url: "/api/campaigns", cookies: auth() });
  const before = ctx.client.request.mock.calls.filter(
    (c: unknown[]) => c[0] === "inventory",
  ).length;

  ctx.helperResponses["inventory"] = {
    inventory: { c1: { d1: { minutes: 45, claimed: false, instanceId: null } } },
  };
  const res = await ctx.app.inject({
    method: "POST", url: "/api/campaigns/refresh", cookies: auth(),
  });

  expect(res.statusCode).toBe(200);
  const after = ctx.client.request.mock.calls.filter(
    (c: unknown[]) => c[0] === "inventory",
  ).length;
  expect(after).toBe(before + 1);
  expect(res.json().campaigns[0].drops[0].minutes).toBe(45);
});

test("refreshing progress alone leaves the catalogue untouched", async () => {
  // The whole point of splitting the button: the catalogue is a detail
  // sweep over every active campaign on a 24h clock, and someone asking
  // "did my minutes land?" must not pay for it.
  let sweeps = 0;
  ctx.setCampaigns(() => { sweeps += 1; return [aCampaign]; });
  ctx.helperResponses["inventory"] = { inventory: {} };
  await ctx.app.inject({ method: "GET", url: "/api/campaigns", cookies: auth() });
  const before = sweeps;

  ctx.helperResponses["inventory"] = {
    inventory: { c1: { d1: { minutes: 45, claimed: false, instanceId: null } } },
  };
  const res = await ctx.app.inject({
    method: "POST", url: "/api/campaigns/refresh?what=progress", cookies: auth(),
  });

  expect(res.statusCode).toBe(200);
  expect(sweeps).toBe(before);
  expect(res.json().campaigns[0].drops[0].minutes).toBe(45);
});

test("refreshing the catalogue alone leaves progress untouched", async () => {
  ctx.setCampaigns(() => [aCampaign]);
  ctx.helperResponses["inventory"] = { inventory: {} };
  await ctx.app.inject({ method: "GET", url: "/api/campaigns", cookies: auth() });
  const before = ctx.client.request.mock.calls.filter(
    (c: unknown[]) => c[0] === "inventory",
  ).length;

  const res = await ctx.app.inject({
    method: "POST", url: "/api/campaigns/refresh?what=catalogue", cookies: auth(),
  });

  expect(res.statusCode).toBe(200);
  const after = ctx.client.request.mock.calls.filter(
    (c: unknown[]) => c[0] === "inventory",
  ).length;
  expect(after).toBe(before);
});

test("an unknown refresh target is rejected rather than sweeping both", async () => {
  // Falling back to "both" would make a typo the expensive path.
  ctx.setCampaigns(() => [aCampaign]);
  ctx.helperResponses["inventory"] = { inventory: {} };
  const res = await ctx.app.inject({
    method: "POST", url: "/api/campaigns/refresh?what=everything", cookies: auth(),
  });
  expect(res.statusCode).toBe(400);
});

test("GET /api/campaigns reports progress unavailable when the fetch fails", async () => {
  // The campaigns must still render -- only the progress is unknown.
  ctx.setCampaigns(() => [aCampaign]);
  ctx.helperResponses["inventory"] = new Error("gql exploded");
  const res = await ctx.app.inject({
    method: "GET", url: "/api/campaigns", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.progressAvailable).toBe(false);
  expect(body.campaigns[0].drops[0].status).toBe("unknown");
  expect(body.campaigns[0].status).toBe("unknown");
});

test("POST /api/campaigns/refresh refetches past the TTL", async () => {
  let calls = 0;
  ctx.setCampaigns(() => { calls += 1; return []; });
  await ctx.app.inject({ method: "GET", url: "/api/campaigns", cookies: auth() });
  const before = calls;
  ctx.setCampaigns(() => { calls += 1; return [aCampaign]; });
  const res = await ctx.app.inject({
    method: "POST", url: "/api/campaigns/refresh", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  expect(calls).toBeGreaterThan(before);
  expect(res.json().campaigns[0].id).toBe("c1");
});

test("GET /api/campaigns requires a session", async () => {
  const res = await ctx.app.inject({ method: "GET", url: "/api/campaigns" });
  expect(res.statusCode).toBe(401);
});

test("POST /api/campaigns/refresh requires a session", async () => {
  const res = await ctx.app.inject({
    method: "POST", url: "/api/campaigns/refresh",
  });
  expect(res.statusCode).toBe(401);
});

test("GET /api/campaigns reports a dead source as unavailable, not as none", async () => {
  // The bug this exists to prevent: a failed campaign fetch rendering as
  // "No drop campaigns are running", which is a claim about Twitch we
  // are in no position to make.
  ctx.setCampaigns(() => { throw new Error("source format changed"); });
  const res = await ctx.app.inject({
    method: "GET", url: "/api/campaigns", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.campaigns).toEqual([]);
  expect(body.catalogueAvailable).toBe(false);
  expect(body.catalogueError).toMatch(/source format changed/);
});

test("GET /api/campaigns reports a genuinely empty list as available", async () => {
  ctx.setCampaigns(() => []);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/campaigns", cookies: auth(),
  });
  const body = res.json();
  expect(body.campaigns).toEqual([]);
  expect(body.catalogueAvailable).toBe(true);
  expect(body.catalogueError).toBeNull();
});

// --- subscriptions ---

const withSubs = (subscriptions: unknown[], streamers: unknown[] = []) => {
  saveConfig(ctx.configPath, {
    version: 1, username: "alex", followers: true, followersOrder: "ASC",
    defaults: {}, miner: {},
    streamers, subscriptions,
  } as never);
};

const aSub = (over: object = {}) => ({
  id: "s1", kind: "campaign", targetId: "c1", label: "Alpha",
  poolSize: 3, rank: 0, ...over,
});

test("GET /api/subscriptions lists them with the channels they own", async () => {
  withSubs([aSub()], [
    { username: "alpha", enabled: true, settings: {} },
    { username: "beta", enabled: true, settings: {}, ownedBy: "s1" },
  ]);
  const res = await ctx.app.inject({
    method: "GET", url: "/api/subscriptions", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  const [sub] = res.json().subscriptions;
  expect(sub.id).toBe("s1");
  // The channels are derived from ownership, not stored twice.
  expect(sub.channels).toEqual(["beta"]);
});

test("POST /api/subscriptions assigns an id and the next rank", async () => {
  withSubs([]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions", cookies: auth(),
    payload: { kind: "campaign", targetId: "c1", label: "Alpha" },
  });
  expect(res.statusCode).toBe(200);
  const sub = res.json().subscription;
  expect(sub.id).toBeTruthy();
  expect(sub.rank).toBe(0);
  expect(sub.poolSize).toBe(3);
});

test("a second subscription ranks after the first", async () => {
  withSubs([aSub({ rank: 0 })]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions", cookies: auth(),
    payload: { kind: "campaign", targetId: "c2", label: "Beta" },
  });
  expect(res.json().subscription.rank).toBe(1);
});

test("subscribing twice to the same target is rejected", async () => {
  // Two subscriptions to one campaign would resolve the same channels
  // and fight over ownership on every pass.
  withSubs([aSub()]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions", cookies: auth(),
    payload: { kind: "campaign", targetId: "c1", label: "Alpha" },
  });
  expect(res.statusCode).toBe(409);
});

test("POST /api/subscriptions rejects a malformed body", async () => {
  withSubs([]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions", cookies: auth(),
    payload: { kind: "streamer", targetId: "c1", label: "x" },
  });
  expect(res.statusCode).toBe(400);
});

test("removing a subscription also drops the streamers it owned", async () => {
  withSubs([aSub()], [
    { username: "alpha", enabled: true, settings: {} },
    { username: "beta", enabled: true, settings: {}, ownedBy: "s1" },
  ]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/s1/remove", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  const saved = loadConfig(ctx.configPath);
  expect(saved.subscriptions).toEqual([]);
  // Removed in the same write, so the two can never disagree.
  expect(saved.streamers.map((s) => s.username)).toEqual(["alpha"]);
});

test("removing an unknown subscription is a 404", async () => {
  withSubs([]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/nope/remove", cookies: auth(),
  });
  expect(res.statusCode).toBe(404);
});

test("reorder rewrites ranks in the given order", async () => {
  withSubs([aSub({ id: "s1", rank: 0 }), aSub({ id: "s2", targetId: "c2", rank: 1 })]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/reorder", cookies: auth(),
    payload: { ids: ["s2", "s1"] },
  });
  expect(res.statusCode).toBe(200);
  const saved = loadConfig(ctx.configPath);
  expect(saved.subscriptions.find((s) => s.id === "s2")?.rank).toBe(0);
  expect(saved.subscriptions.find((s) => s.id === "s1")?.rank).toBe(1);
});

test("reorder runs a pass so the new order reaches the miner", async () => {
  // Rank alone changes nothing the miner can see: the engine writes the
  // streamer list in rank order, and THAT order is what upstream's
  // priority_order consumes. Without a pass the new ranks sit in the
  // config while the miner keeps watching in the old order.
  withSubs([aSub({ id: "s1", rank: 0 }), aSub({ id: "s2", targetId: "c2", rank: 1 })]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/reorder", cookies: auth(),
    payload: { ids: ["s2", "s1"] },
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.engine.pass).toHaveBeenCalledTimes(1);
});

test("a rejected reorder does not run a pass", async () => {
  // Nothing was written, so there is nothing to propagate.
  withSubs([aSub({ id: "s1" }), aSub({ id: "s2", targetId: "c2", rank: 1 })]);
  await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/reorder", cookies: auth(),
    payload: { ids: ["s1"] },
  });
  expect(ctx.engine.pass).not.toHaveBeenCalled();
});

test("reorder rejects a list that is not the full set", async () => {
  // A partial list would leave the missing ones with stale ranks.
  withSubs([aSub({ id: "s1" }), aSub({ id: "s2", targetId: "c2", rank: 1 })]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/reorder", cookies: auth(),
    payload: { ids: ["s1"] },
  });
  expect(res.statusCode).toBe(400);
});

test("pool size can be changed", async () => {
  withSubs([aSub({ poolSize: 3 })]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/s1/pool-size", cookies: auth(),
    payload: { poolSize: 6 },
  });
  expect(res.statusCode).toBe(200);
  expect(loadConfig(ctx.configPath).subscriptions[0]?.poolSize).toBe(6);
});

test("changing the pool size runs a pass so the new size reaches the miner", async () => {
  // The stored number alone owns no channels: the pass is what resolves
  // the bigger or smaller pool and proposes the restart that applies it.
  withSubs([aSub({ poolSize: 3 })]);
  await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/s1/pool-size", cookies: auth(),
    payload: { poolSize: 6 },
  });
  expect(ctx.engine.pass).toHaveBeenCalledTimes(1);
});

test("a failed resolve still leaves the new pool size saved", async () => {
  // Same bargain as subscribing: the number is written either way, so
  // failing the request would suggest it was not.
  withSubs([aSub({ poolSize: 3 })]);
  ctx.engine.pass.mockRejectedValueOnce(new Error("directory down"));
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/s1/pool-size", cookies: auth(),
    payload: { poolSize: 6 },
  });
  expect(res.statusCode).toBe(200);
  expect(loadConfig(ctx.configPath).subscriptions[0]?.poolSize).toBe(6);
});

test("a pool size outside the allowed range is rejected", async () => {
  // The bound lives in the schema; the route must not invent its own.
  withSubs([aSub({ poolSize: 3 })]);
  for (const poolSize of [0, 11, 2.5, "3", null]) {
    const res = await ctx.app.inject({
      method: "POST", url: "/api/subscriptions/s1/pool-size", cookies: auth(),
      payload: { poolSize },
    });
    expect(res.statusCode, String(poolSize)).toBe(400);
  }
  expect(loadConfig(ctx.configPath).subscriptions[0]?.poolSize).toBe(3);
  expect(ctx.engine.pass).not.toHaveBeenCalled();
});

test("setting the pool size of an unknown subscription is a 404", async () => {
  withSubs([aSub({ id: "s1" })]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/nope/pool-size", cookies: auth(),
    payload: { poolSize: 5 },
  });
  expect(res.statusCode).toBe(404);
  expect(ctx.engine.pass).not.toHaveBeenCalled();
});

test("POST /api/subscriptions/resolve runs a pass immediately", async () => {
  withSubs([aSub()]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions/resolve", cookies: auth(),
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.engine.pass).toHaveBeenCalledTimes(1);
});

test("restart cancel and fire-now reach the pending restart", async () => {
  const cancel = await ctx.app.inject({
    method: "POST", url: "/api/restart/cancel", cookies: auth(),
  });
  expect(cancel.statusCode).toBe(200);
  expect(ctx.pending.cancel).toHaveBeenCalledTimes(1);

  const now = await ctx.app.inject({
    method: "POST", url: "/api/restart/now", cookies: auth(),
  });
  expect(now.statusCode).toBe(200);
  expect(ctx.pending.fireNow).toHaveBeenCalledTimes(1);
});

test("the subscription routes require a session", async () => {
  for (const url of [
    "/api/subscriptions", "/api/subscriptions/reorder",
    "/api/subscriptions/resolve", "/api/subscriptions/s1/pool-size",
    "/api/restart/cancel",
  ]) {
    const res = await ctx.app.inject({ method: "POST", url });
    expect(res.statusCode, url).toBe(401);
  }
});

test("the status frame carries the pending restart, for a late joiner", async () => {
  // The SSE event only reaches clients attached when it fired; a browser
  // opened mid-countdown would otherwise show no banner at all.
  const res = await ctx.app.inject({
    method: "GET", url: "/api/status", cookies: auth(),
  });
  expect(res.json().pendingRestart).toEqual({
    pending: false, dueAt: null, reason: null,
  });
});

test("subscribing resolves straight away rather than waiting for the timer", async () => {
  // A button press that visibly does nothing for fifteen minutes reads
  // as broken, so the route runs a pass itself.
  withSubs([]);
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions", cookies: auth(),
    payload: { kind: "campaign", targetId: "c1", label: "Alpha" },
  });
  expect(res.statusCode).toBe(200);
  expect(ctx.engine.pass).toHaveBeenCalledTimes(1);
});

test("a failed resolve still leaves the subscription created", async () => {
  // The subscription is saved either way; the next pass picks it up.
  // Failing the request would leave the user unsure whether it existed.
  withSubs([]);
  ctx.engine.pass.mockRejectedValueOnce(new Error("directory down"));
  const res = await ctx.app.inject({
    method: "POST", url: "/api/subscriptions", cookies: auth(),
    payload: { kind: "campaign", targetId: "c1", label: "Alpha" },
  });
  expect(res.statusCode).toBe(200);
  expect(loadConfig(ctx.configPath).subscriptions).toHaveLength(1);
});

test("the app log route returns the ring and its total", async () => {
  const { app, cookie } = await make({
    appLog: {
      buffer: {
        entries: () => [{ type: "a.thing", msg: "happened", level: "info", time: 1 }],
        total: 7,
      },
      onEvent: () => {},
    },
  });
  const res = await app.inject({
    method: "GET", url: "/api/app-log", cookies: { session: cookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    events: [{ type: "a.thing", msg: "happened", level: "info", time: 1 }],
    total: 7,
    enabled: true,
  });
  await app.close();
});

test("the app log route reports being switched off, not broken", async () => {
  // A disabled log is a configuration, not a failure: the UI needs to
  // tell them apart to avoid showing a blank panel that looks broken.
  const { app, cookie } = await make();
  const res = await app.inject({
    method: "GET", url: "/api/app-log", cookies: { session: cookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ events: [], total: 0, enabled: false });
  await app.close();
});

test("the app log route needs a session", async () => {
  const { app } = await make();
  const res = await app.inject({ method: "GET", url: "/api/app-log" });
  expect(res.statusCode).toBe(401);
  await app.close();
});
