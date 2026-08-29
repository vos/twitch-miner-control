import Fastify, { type FastifyInstance } from "fastify";
import { type AppConfig, configSchema, usernameSchema } from "../config/schema.js";
import { loadConfig, saveConfig } from "../config/store.js";
import type { History } from "../db/history.js";
import type { LoginRunner } from "../helpers/loginRunner.js";
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
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const hub = new SseHub();
  let staged: AppConfig | null = null;

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
  deps.loginRunner.on("progress", (p) => hub.broadcast("login", p));

  return app;
}
