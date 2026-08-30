import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { type AppConfig, configSchema, usernameSchema } from "../config/schema.js";
import { loadConfig, saveConfig } from "../config/store.js";
import type { History } from "../db/history.js";
import type { LoginProgress, LoginRunner } from "../helpers/loginRunner.js";
import type { NdjsonClient } from "../helpers/ndjsonClient.js";
import type { Supervisor } from "../miner/supervisor.js";
import type { StateService } from "../state/service.js";
import { registerAuth } from "./auth.js";
import { SseHub } from "./sse.js";

/**
 * Shape of a doorbell event name. `python/helpers/doorbell.py` posts
 * `str(event)` for an upstream `Events` member -- bare upper-snake-case
 * names like `STREAMER_ONLINE` or `GAIN_FOR_CLAIM`, pinned by
 * `python/tests/test_doorbell.py`. The value is written straight into the
 * `events` table and rendered by the UI, so it is bounded and shaped here
 * rather than trusted: the doorbell token authenticates the caller, not
 * the payload, and a miner bug or a stray poster on the LAN must not be
 * able to stuff arbitrary text into history.
 */
const DOORBELL_EVENT = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Parses a required numeric query parameter.
 *
 * Returns null for anything that is not a finite number, including a
 * missing parameter and an empty one -- `Number(undefined)` is NaN and
 * `Number("")` is 0, and better-sqlite3 binds both without complaint
 * (verified against v11: an out-of-range or NULL bind yields an empty
 * result set, not an error). Silently answering a malformed range with an
 * empty series would show the dashboard a flat "no data" chart that is
 * indistinguishable from a genuinely empty history, so the route rejects
 * instead.
 */
function finiteParam(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ServerDeps {
  configPath: string;
  password: string;
  doorbellToken: string;
  supervisor: Supervisor;
  stateService: StateService;
  history: History;
  helper: NdjsonClient;
  loginRunner: LoginRunner;
  /**
   * Absolute path to the built frontend (`apps/frontend/dist`). When set,
   * the static build is mounted at `/*` and unmatched non-API paths fall
   * back to `index.html` for client-side routing. Left undefined in every
   * test in this file -- those exercise the API in isolation and never
   * need a built frontend on disk.
   */
  staticRoot?: string;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const hub = new SseHub();
  let staged: AppConfig | null = null;

  /**
   * Replaces the long-lived state helper, then pulls fresh numbers.
   *
   * The helper is spawned once and kept, but `python/helpers/_session.py`
   * freezes the cookie pickle's path as `{TWITCH_USERNAME}.pkl` when it
   * starts, and `reload_cookies()` re-reads that same frozen path. A helper
   * spawned at boot -- before the user has entered a username or logged in
   * -- therefore reads `cookies/.pkl` for the life of the process, so a
   * user who logs in successfully is still reported logged out until the
   * backend restarts. Only a new process picks the change up, which is why
   * this runs on the two events that can change the username or the cookie
   * file: a successful login, and a config apply.
   *
   * Recycling rejects whatever request was in flight. StateService turns
   * that into a stale snapshot rather than a hang, so a refresh is kicked
   * off immediately to replace those numbers instead of leaving the
   * dashboard stale until the next 60s tick. A doorbell ring's pending
   * debounce timer is untouched by any of this and still fires.
   */
  async function recycleHelper(): Promise<void> {
    await deps.helper.restart();
    // Never rejects (StateService#doRefresh swallows), but this is called
    // fire-and-forget from an event handler, so guard it anyway.
    await deps.stateService.refresh().catch(() => {});
  }

  app.register(async (instance) => {
    await registerAuth(instance, { password: deps.password });
    hub.register(instance);

    instance.get("/api/config", async () => staged ?? loadConfig(deps.configPath));

    instance.put("/api/config", async (request, reply) => {
      const parsed = configSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.message });
      }
      staged = parsed.data;
      return { pending: true };
    });

    instance.post("/api/config/apply", async () => {
      if (staged === null) return { applied: false };
      saveConfig(deps.configPath, staged);
      staged = null;
      // The applied config may name a different Twitch username, so the
      // state helper has to be recycled alongside the miner -- see
      // recycleHelper(). Awaited (it is a local process kill, not a network
      // call) so the response means both children are already gone.
      await recycleHelper();
      await deps.supervisor.restart();
      return { applied: true };
    });

    instance.get("/api/status", async () => {
      const snapshot = deps.stateService.snapshot();
      const loginRequired =
        deps.loginRunner.current === null ||
        deps.loginRunner.current.stage === "error" ||
        loadConfig(deps.configPath).username === "";
      return {
        miner: deps.supervisor.state,
        loginRequired,
        login: deps.loginRunner.current,
        lastUpdated: snapshot.lastUpdated,
        stale: snapshot.stale,
        error: snapshot.error,
        pendingChanges: staged !== null,
      };
    });

    instance.get("/api/streamers", async () => deps.stateService.snapshot());

    instance.get("/api/followers", async () => deps.helper.request("followers"));

    instance.get("/api/streamers/lookup", async (request, reply) => {
      const q = (request.query as { q?: string }).q ?? "";
      if (!usernameSchema.safeParse(q).success) {
        return reply.code(400).send({ error: "not a valid Twitch username" });
      }
      return deps.helper.request("lookup", { username: q });
    });

    instance.get("/api/history", async (request, reply) => {
      const q = request.query as { streamer?: unknown; from?: unknown; to?: unknown };
      // Reuses the lookup route's username rule: the same value that can be
      // added as a streamer is the only value that can be charted.
      const streamer = usernameSchema.safeParse(q.streamer);
      if (!streamer.success) {
        return reply
          .code(400)
          .send({ error: "streamer must be a valid Twitch username" });
      }
      const from = finiteParam(q.from);
      const to = finiteParam(q.to);
      if (from === null || to === null) {
        return reply.code(400).send({ error: "from and to must be finite numbers" });
      }
      return {
        series: deps.history.pointsSeries(streamer.data, from, to),
        events: deps.history.recentEvents(100),
      };
    });

    instance.get("/api/logs", async () => ({ lines: deps.supervisor.logs() }));

    for (const action of ["start", "stop", "restart"] as const) {
      instance.post(`/api/miner/${action}`, async () => {
        await deps.supervisor[action]();
        return { state: deps.supervisor.state };
      });
    }

    instance.post("/api/twitch/login", async () => {
      deps.loginRunner.start();
      return { started: true };
    });
  });

  if (deps.staticRoot) {
    void app.register(fastifyStatic, { root: deps.staticRoot });
    // A 404 handler runs precisely because no route matched, so unlike the
    // auth hook (which reads the router's already-decoded routeOptions.url)
    // there is no matched pattern here -- request.url, raw off the wire, is
    // all there is. Fastify's router percent-decodes before matching, so a
    // path like `/%61pi/nope` reaches this handler with a raw URL that does
    // not start with "/api/" even though it names an API path. Decoding
    // first keeps that case a JSON 404 instead of a false-positive SPA
    // fallback. decodeURIComponent throws on a malformed escape (e.g. a
    // bare "%"), which is not an API path either way, so the raw string is
    // a fine fallback input for the prefix check.
    app.setNotFoundHandler((request, reply) => {
      const rawPath = request.url.split("?")[0];
      let path = rawPath;
      try {
        path = decodeURIComponent(rawPath);
      } catch {
        // Malformed percent-escape -- fall back to the raw path.
      }
      if (path.startsWith("/api/") || path.startsWith("/internal/")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  // The only route mounted at the root. It carries its own shared token
  // because the caller is the miner subprocess, not a browser, so it has no
  // session cookie to present. Everything else lives inside the auth scope
  // above: registerAuth's onRequest hook is encapsulated to that scope, and
  // a route registered out here would silently skip the session check.
  app.post("/internal/doorbell", async (request, reply) => {
    if (request.headers["x-doorbell-token"] !== deps.doorbellToken) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const body = request.body as { event?: unknown } | undefined;
    const event = body?.event;
    if (typeof event !== "string" || !DOORBELL_EVENT.test(event)) {
      return reply.code(400).send({ error: "event must be an upper snake case name" });
    }
    deps.stateService.ring(event);
    return reply.code(204).send();
  });

  deps.stateService.on("change", (snapshot) => hub.broadcast("state", snapshot));
  deps.supervisor.on("state", (state) => hub.broadcast("miner", { state }));
  deps.loginRunner.on("progress", (p: LoginProgress) => {
    hub.broadcast("login", p);
    // A completed login writes the cookie pickle the state helper reads,
    // under whatever username the config names now -- neither of which the
    // running helper can see. Fire-and-forget: the SSE frame above must not
    // wait on a process restart.
    if (p.stage === "ok") void recycleHelper();
  });

  return app;
}
