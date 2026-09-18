import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { ZodError } from "zod";
import {
  type AppConfig, configSchema, subscriptionSchema, usernameSchema,
} from "../config/schema.js";
import { loadConfig, saveConfig } from "../config/store.js";
import { UpdateChecker } from "../config/updateCheck.js";
import { resolveVersion } from "../config/version.js";
import type { History } from "../db/history.js";
import type { Streamers } from "../db/streamers.js";
import type { LoginProgress, LoginRunner } from "../helpers/loginRunner.js";
import type { LoginStatus } from "../helpers/loginStatus.js";
import { type NdjsonClient, NdjsonError } from "../helpers/ndjsonClient.js";
import { ProcStats } from "../miner/procStats.js";
import type { Supervisor } from "../miner/supervisor.js";
import type { SubscriptionEngine } from "../drops/engine.js";
import type { PendingRestart } from "../drops/pendingRestart.js";
import type { CampaignCatalogue } from "../state/campaignCatalogue.js";
import { resolveCampaign } from "../state/dropState.js";
import { gainWindow } from "../state/gains.js";
import type { InventoryCache } from "../state/inventory.js";
import type { StateService } from "../state/service.js";
import { clip, intersect, total } from "../state/spans.js";
import { registerAuth } from "./auth.js";
import { SseHub } from "./sse.js";

/**
 * Resolved once at module load rather than per request: it cannot change
 * while the process runs, and the manifest fallback touches the disk.
 */
const APP_VERSION = resolveVersion(process.env.APP_VERSION);

/**
 * Polls GitHub for a newer release of this app, so the sidebar can say so
 * next to the version readout. Module-scoped alongside APP_VERSION, which
 * it compares against: one checker for the process, holding the last
 * answer between status requests rather than asking GitHub per request.
 *
 * index.ts starts its schedule; until then, and whenever a check fails,
 * it offers nothing.
 */
export const updateChecker = new UpdateChecker({ current: APP_VERSION });

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
 * Longest doorbell message kept, matching MAX_MESSAGE in
 * `python/helpers/doorbell.py`. Enforced again here because the sender is
 * bounded by convention while this endpoint is reachable by anyone holding
 * the token, and the value lands in the events table and then the UI.
 */
const DOORBELL_MESSAGE_MAX = 500;

/**
 * Reduces a doorbell message to the bounded single line the feed renders.
 *
 * Unlike the event name this is free text, so it is sanitised rather than
 * pattern-matched: control characters (ANSI colour escapes, the newlines
 * in a bet recap) collapse to spaces so a row cannot break the feed's
 * layout, and anything absent or malformed degrades to null -- a row with
 * no message still renders from its type.
 */
function doorbellMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .trim()
    .slice(0, DOORBELL_MESSAGE_MAX);
  return text === "" ? null : text;
}

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

/**
 * Renders a rejected config as something a person can act on.
 *
 * `ZodError#message` is a JSON dump of the raw issue array -- brackets,
 * `expected`/`received` keys and all -- and the frontend puts whatever the
 * API returns straight into an alert, so the user was shown a serialized
 * parser internal instead of a sentence. Each issue becomes
 * "<where>: <what>" and they are joined, which keeps every issue (a config
 * can fail in several places at once) while staying one readable line.
 */
function describeConfigError(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join(".") : "config";
    return `${where}: ${issue.message}`;
  });
  return issues.length > 0 ? issues.join("; ") : "config is not valid";
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export interface ServerDeps {
  configPath: string;
  password: string;
  /**
   * Sets `Secure` on the session cookie -- for deployments that terminate
   * TLS at a reverse proxy. Off by default; see config/envFlag.ts.
   */
  secureCookie?: boolean;
  /**
   * Makes Fastify derive `request.ip` from `X-Forwarded-For` instead of the
   * socket peer. Only ever safe when a proxy in front is overwriting that
   * header, which is why it is opt-in: with it on and no such proxy, any
   * caller can forge the address the login limiter counts against.
   */
  trustProxy?: boolean;
  doorbellToken: string;
  supervisor: Supervisor;
  stateService: StateService;
  history: History;
  /**
   * The roster store, read for `first_seen_ts` -- the floor under every
   * mining figure. Optional, and read defensively, exactly as
   * StateService reads it: a server built without one still answers,
   * with an unfloored figure, rather than failing to build.
   */
  streamers?: Streamers;
  helper: NdjsonClient;
  loginRunner: LoginRunner;
  /**
   * Whether the stored Twitch session is currently usable. Owned outside
   * the server because the answer is established before it exists (the
   * boot `check_login` in index.ts) and changed by things that are not HTTP
   * requests (a helper reporting AUTH, a login completing).
   */
  loginStatus: LoginStatus;
  /**
   * Directory holding the Twitch cookie pickles, one per account
   * (`{username}.pkl` -- see python/helpers/_session.py). Needed so a
   * logout can delete the stored session; the login path never touches it
   * from here, the Python helper writes it directly.
   */
  cookiesDir: string;
  /**
   * The drop campaign catalogue, on its own 24h clock. Owned outside the
   * server because it is persisted and survives a rebuild of the routes.
   */
  catalogue: CampaignCatalogue;
  /** Viewer drop progress, on the ten-minute clock. */
  inventory: InventoryCache;
  /** Resolves subscriptions into channels; driven on its own timer. */
  engine: Pick<SubscriptionEngine, "pass">;
  /**
   * The engine's cancellable restart, surfaced for the dashboard banner.
   *
   * The server attaches its own SSE hub to this, since the hub lives in
   * here -- the caller constructs it without a broadcast and gets one
   * wired up as a side effect of building the server.
   */
  pendingRestart: Pick<PendingRestart, "cancel" | "fireNow" | "state"> & {
    setBroadcast?: (fn: (event: string, data: unknown) => void) => void;
  };
  /**
   * Absolute path to the built frontend (`apps/frontend/dist`). When set,
   * the static build is mounted at `/*` and unmatched non-API paths fall
   * back to `index.html` for client-side routing. Left undefined in every
   * test in this file -- those exercise the API in isolation and never
   * need a built frontend on disk.
   */
  staticRoot?: string;
  /** How often connected clients get a fresh status. Overridable for tests. */
  statusTickMs?: number;
}

/**
 * How often a status frame goes out while anyone is connected. The miner's
 * CPU and memory change continuously, so events alone cannot carry them.
 */
export const STATUS_TICK_MS = 5_000;

/**
 * A Fastify instance plus the one piece of live server state the rest of
 * the process needs to see: whether anybody is connected.
 */
export interface AppServer extends FastifyInstance {
  /** How many SSE clients are attached right now. */
  readonly clientCount: number;
}

export function buildServer(deps: ServerDeps): AppServer {
  // /api/stream hijacks its socket for a live SSE connection that never
  // ends on its own. Node's http.Server#close() waits for every open
  // connection to end before its callback fires -- a hijacked socket
  // counts as open exactly like any other -- so app.close() hung
  // indefinitely with even one browser tab holding the dashboard open,
  // which meant process.exit(0) in index.ts's SIGTERM handler never ran
  // and Docker SIGKILLed the container on every deploy. forceCloseConnections
  // makes close() forcibly destroy every open socket (Node's
  // server.closeAllConnections(), available since Node 18.2) instead of
  // waiting for them to end gracefully -- appropriate here because a
  // shutting-down backend has nothing left to say to a client anyway.
  const app = Fastify({
    logger: false,
    forceCloseConnections: true,
    trustProxy: deps.trustProxy ?? false,
  });
  // The state service runs a reduced pass while nobody is watching, so
  // the first client to connect has to ask for the full one. Fire and
  // forget: the refresh emits "change", which reaches this client over
  // the stream it has just opened.
  const hub = new SseHub({
    onFirstClient: () => { void deps.stateService.refresh().catch(() => {}); },
  });
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

  /**
   * Records the Twitch account a successful login belongs to.
   *
   * Without this, nothing ever wrote `username` back: a fresh install could
   * complete the device-code flow and still hold `username: ""`, which
   * leaves the state helper reading `cookies/.pkl` and the miner refusing
   * to start. Writes straight to disk rather than through `staged`, because
   * this is a fact about the account, not an edit the user has to confirm
   * -- and it must survive without an Apply. A no-op when the name already
   * matches, so a re-login does not rewrite the file.
   */
  function persistUsername(username: string): void {
    try {
      const current = loadConfig(deps.configPath);
      if (current.username === username) return;
      saveConfig(deps.configPath, { ...current, username });
      // Staged edits were made against the old username; keep them, but do
      // not let an Apply write the stale name back over the one Twitch just
      // confirmed.
      if (staged !== null) staged = { ...staged, username };
    } catch (cause) {
      app.log.error({ err: cause }, "could not persist the logged-in username");
    }
  }

  // Held across calls, not built per call: CPU percent is a delta between
  // two readings, so the previous sample has to survive from one status to
  // the next (see ProcStats).
  const procStats = new ProcStats();

  /** What GET /api/status answers and every status frame carries. */
  function status() {
    const snapshot = deps.stateService.snapshot();
    // Two independent reasons to send the user to the sign-in screen: no
    // account has been named yet (a fresh install), or the session behind
    // that account is not usable -- see LoginStatus for why the login
    // *runner*'s progress cannot answer this.
    const loginRequired =
      loadConfig(deps.configPath).username === "" || deps.loginStatus.required;
    const livePid = deps.supervisor.livePids()[0];
    return {
      miner: deps.supervisor.state,
      // Null unless a live miner process exists -- see Supervisor#runningSince.
      // The dashboard ticks its uptime readout from this rather than from a
      // server-computed elapsed figure, so the timer stays smooth between
      // status frames instead of jumping once every tick.
      startedAt: deps.supervisor.runningSince,
      // CPU and memory for the miner process, or null when nothing is
      // running -- and equally when /proc cannot be read, which is how
      // this degrades on a non-Linux dev machine instead of failing
      // the whole status route over a decorative readout.
      stats: livePid === undefined ? null : procStats.sample(livePid, Date.now()),
      loginRequired,
      login: deps.loginRunner.current,
      lastUpdated: snapshot.lastUpdated,
      stale: snapshot.stale,
      error: snapshot.error,
      pendingChanges: staged !== null,
      // Rides the status frame as well as its own SSE event, so a client
      // connecting mid-countdown still sees the banner -- the event
      // alone only reaches clients already attached when it fired.
      pendingRestart: deps.pendingRestart.state(),
      version: APP_VERSION,
      // Null unless a strictly newer release exists, so the frontend
      // renders the notice iff this is set.
      latestVersion: updateChecker.available,
    };
  }

  /**
   * Sends every connected client the current status. Called from timers and
   * event handlers, where a throw -- config.json unreadable, say -- would
   * take the process down rather than fail one request.
   */
  function pushStatus(): void {
    try {
      hub.broadcast("status", status());
    } catch (cause) {
      app.log.error({ err: cause }, "could not build a status frame");
    }
  }

  const statusTick = setInterval(() => {
    if (hub.clientCount > 0) pushStatus();
  }, deps.statusTickMs ?? STATUS_TICK_MS);
  // Never let a status tick for zero clients keep the process alive.
  statusTick.unref();
  app.addHook("onClose", () => { clearInterval(statusTick); });

  app.register(async (instance) => {
    await registerAuth(instance, {
      password: deps.password,
      secureCookie: deps.secureCookie,
    });
    hub.register(instance);

    instance.get("/api/config", async () => staged ?? loadConfig(deps.configPath));

    instance.put("/api/config", async (request, reply) => {
      const parsed = configSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: describeConfigError(parsed.error) });
      }
      staged = parsed.data;
      return { pending: true };
    });

    instance.post("/api/config/apply", async (_request, reply) => {
      if (staged === null) return { applied: false };
      // Split into two guarded phases because they fail differently and the
      // user has to be told which one happened. Unhandled, a throw from
      // either one became a bare "Internal Server Error" -- and after the
      // write had landed, `pendingChanges` then read false, so the UI
      // claimed the changes were live while the miner was still running the
      // old config.
      try {
        saveConfig(deps.configPath, staged);
      } catch (cause) {
        // config.json is untouched (saveConfig writes to a temp file and
        // renames), so the staged changes are still the pending ones.
        return reply.code(500).send({
          error: `could not write config.json: ${messageOf(cause)}. Your changes are still pending.`,
        });
      }
      staged = null;
      try {
        // The applied config may name a different Twitch username, so the
        // state helper has to be recycled alongside the miner -- see
        // recycleHelper(). Awaited (it is a local process kill, not a
        // network call) so the response means both children are already gone.
        await recycleHelper();
        // Same guard index.ts applies at boot: a miner started without a
        // usable session, or without an account to mine as, exits at once
        // and parks in CRASHED. Saving a username from the sign-in screen
        // necessarily happens before the first login, so apply must be
        // able to persist config without starting anything. The miner is
        // started by the login flow once a session exists.
        const runnable =
          !deps.loginStatus.required && loadConfig(deps.configPath).username !== "";
        if (runnable) await deps.supervisor.restart();
        else await deps.supervisor.stop();
      } catch (cause) {
        return reply.code(500).send({
          error: `config.json was saved but the miner could not be restarted: ${messageOf(cause)}. The miner is still running the previous configuration -- restart it from the dashboard.`,
        });
      }
      return { applied: true };
    });

    instance.get("/api/status", async () => status());

    // Never waits on Twitch. The held snapshot is returned as-is and the
    // client is told whether it is drawable yet.
    //
    // Waiting here is tempting -- an undrawn snapshot has no gains,
    // sparklines or avatars -- but it buys nothing. The state pass is
    // slow by nature: python/helpers/state.py issues one GQL call per
    // streamer, plus one per live channel for drops, all sequential, so
    // a roster of eight takes many seconds. The dashboard subscribes to
    // the SSE "state" event before it fetches (useLiveState.ts), and the
    // refresh below emits exactly that when it lands, so the data
    // arrives either way. Blocking only chose which way the wait looked:
    // a spinner instead of the skeleton the dashboard already draws.
    //
    // `pending` is what keeps that skeleton up. Without it the client
    // cannot tell "no streamers yet" from "this user follows nobody",
    // and a cold start rendered a finished-looking empty page.
    instance.get("/api/streamers", async () => {
      const pending = deps.stateService.needsDerive;
      if (pending) {
        // Paint from the database first, synchronously, so this response
        // carries real cards -- names, cached avatars, balances, gains,
        // sparklines -- instead of an empty roster. Doing it inside the
        // refresh below would be too late: that call's first await lands
        // after this handler has already read the snapshot.
        await deps.stateService.paintLocal();
        // Then the live pass, fire and forget. It resolves into an SSE
        // frame, not this response.
        void deps.stateService.refresh().catch(() => {});
      }
      return { ...deps.stateService.snapshot(), pending };
    });

    // Type, time, and the miner's own formatted line -- which is what
    // names the channel (see history.ts's recordEvent). Rows written
    // before the doorbell carried a message have a null one.
    instance.get("/api/events", async () => ({
      events: deps.history.recentEvents(20),
    }));

    /**
     * The Drops page's whole payload: the campaign catalogue joined with
     * this viewer's progress.
     *
     * The two ages are reported separately on purpose. They sit on clocks
     * a day apart, and collapsing them into one "updated N ago" would
     * describe neither. `progressAvailable` travels with them because an
     * absent drop means "never started" only when the fetch worked.
     */
    async function campaignPayload(refresh: boolean) {
      const cat = refresh
        ? await deps.catalogue.refresh()
        : await deps.catalogue.get();
      const inv = await deps.inventory.get();
      return {
        campaigns: cat.campaigns.map((c) => resolveCampaign(c, inv)),
        catalogueFetchedAt: cat.fetchedAt,
        catalogueStale: cat.stale,
        // Distinguishes "no campaigns are running" from "we could not
        // read the list at all" -- without this the page reports a dead
        // source as a fact about Twitch.
        catalogueAvailable: cat.available,
        catalogueError: cat.error,
        progressFetchedAt: inv.fetchedAt,
        progressAvailable: inv.available,
      };
    }

    instance.get("/api/campaigns", async () => campaignPayload(false));

    // Bypasses the TTL for a campaign that has just been announced. The
    // cache rate limits this itself, so a double click costs one sweep.
    instance.post("/api/campaigns/refresh", async () => campaignPayload(true));

    /**
     * The subscriptions, each with the channels it currently owns.
     *
     * `channels` is derived from the streamer list rather than stored on
     * the subscription, so the two can never drift: what the engine
     * wrote IS what this reports.
     */
    instance.get("/api/subscriptions", async () => {
      const config = loadConfig(deps.configPath);
      return {
        subscriptions: [...config.subscriptions]
          .sort((a, b) => a.rank - b.rank)
          .map((sub) => ({
            ...sub,
            channels: config.streamers
              .filter((s) => s.ownedBy === sub.id)
              .map((s) => s.username),
          })),
      };
    });

    instance.post("/api/subscriptions", async (request, reply) => {
      const config = loadConfig(deps.configPath);
      const body = subscriptionSchema
        .omit({ id: true, rank: true })
        .safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "not a valid subscription" });
      }
      // One subscription per target: two would resolve the same channels
      // and fight over ownership on every pass.
      const clash = config.subscriptions.some(
        (s) => s.kind === body.data.kind && s.targetId === body.data.targetId,
      );
      if (clash) {
        return reply.code(409).send({ error: "already subscribed to that" });
      }
      const subscription = {
        ...body.data,
        id: randomUUID(),
        // Appended last: a new subscription should not outrank the ones
        // already there without the user saying so.
        rank: config.subscriptions.length,
      };
      saveConfig(deps.configPath, {
        ...config,
        subscriptions: [...config.subscriptions, subscription],
      });
      // Resolved now rather than on the engine's next quarter-hour pass:
      // a button press that visibly does nothing for fifteen minutes
      // reads as broken. Failures are swallowed on purpose -- the
      // subscription is already saved and the next pass will pick it up,
      // so failing the request would leave the user unsure whether it
      // exists at all.
      await deps.engine.pass().catch(() => {});
      return { subscription };
    });

    instance.post("/api/subscriptions/reorder", async (request, reply) => {
      const config = loadConfig(deps.configPath);
      const ids = (request.body as { ids?: unknown }).ids;
      const known = new Set(config.subscriptions.map((s) => s.id));
      // The full set, or ranks left out of the list keep stale values
      // and the order becomes ambiguous.
      const complete =
        Array.isArray(ids)
        && ids.length === known.size
        && ids.every((id) => typeof id === "string" && known.has(id));
      if (!complete) {
        return reply.code(400).send({ error: "ids must list every subscription" });
      }
      const rankOf = new Map((ids as string[]).map((id, i) => [id, i]));
      saveConfig(deps.configPath, {
        ...config,
        subscriptions: config.subscriptions.map((s) => ({
          ...s, rank: rankOf.get(s.id) ?? s.rank,
        })),
      });
      // New ranks alone change nothing the miner can see. The engine
      // writes the streamer list in rank order, and that written order is
      // what upstream's priority_order consumes -- so the pass is what
      // turns a reorder into different behaviour, and its reconcile is
      // what proposes the restart that applies it. Without this the new
      // order sits in the config until the next quarter-hour pass.
      //
      // Swallowed like the subscribe route's: the ranks are already
      // saved, so failing the request would suggest they were not.
      await deps.engine.pass().catch(() => {});
      return { ok: true };
    });

    /**
     * POST rather than DELETE: every other mutating route in this file
     * is a POST, and the client has no delete helper.
     */
    instance.post("/api/subscriptions/:id/remove", async (request, reply) => {
      const { id } = request.params as { id: string };
      const config = loadConfig(deps.configPath);
      if (!config.subscriptions.some((s) => s.id === id)) {
        return reply.code(404).send({ error: "no such subscription" });
      }
      // Both in one write, so the config can never hold a streamer owned
      // by a subscription that no longer exists.
      saveConfig(deps.configPath, {
        ...config,
        subscriptions: config.subscriptions.filter((s) => s.id !== id),
        streamers: config.streamers.filter((s) => s.ownedBy !== id),
      });
      return { ok: true };
    });

    /** Re-resolve now rather than waiting out the engine's timer. */
    instance.post("/api/subscriptions/resolve", async (_request, reply) => {
      try {
        await deps.engine.pass();
      } catch (cause) {
        return reply.code(500).send({ error: messageOf(cause) });
      }
      return { ok: true };
    });

    instance.post("/api/restart/cancel", async () => {
      deps.pendingRestart.cancel();
      return { ok: true };
    });

    instance.post("/api/restart/now", async () => {
      await deps.pendingRestart.fireNow();
      return { ok: true };
    });

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
      const login = streamer.data;
      // The floor under every mining figure: streamer_sessions.start_ts
      // is Twitch's own createdAt, so a channel added mid-stream has a
      // session back-dated to a start we were never present for. Without
      // this, that channel's first stream reports its whole length as
      // mined. Composed exactly as state/service.ts does it.
      const firstSeen = deps.streamers?.firstSeen(login) ?? null;
      const floor = firstSeen ?? 0;
      const minerSpans = deps.history.minerSpans();
      const sessions = deps.history.sessionsFor(login, from).map((s) => {
        const end = s.end ?? to;
        const mined = total(intersect(
          clip([{ start: s.start, end: s.end }], floor, end),
          clip(minerSpans, floor, end),
        ));
        // balanceAt, not latest: writes are change-only, so the balance
        // in force at a session's end is the most recent snapshot at or
        // before it. A null anchor means the earning is unknowable.
        const closing = deps.history.balanceAt(login, end);
        const earned = s.anchorPoints === null || closing === null
          ? null
          : closing - s.anchorPoints;
        return { streamId: s.streamId, start: s.start, end: s.end, mined, earned };
      });
      const liveSpans = deps.history.streamerSpans(login, from);
      // The window's gain, by the same rule the dashboard card uses for
      // its 24h figure -- the closing balance less the balance in force
      // at `from`. NOT the first and last samples of `series`: that
      // series is clipped to the window, so its first row already
      // includes its own gain and differencing inside it undercounts by
      // exactly that much. The baseline is the balance *before* the
      // window, which is a row `series` does not contain.
      const window = gainWindow(deps.history, login, from, to);
      const closing = deps.history.balanceAt(login, to);
      return {
        series: deps.history.pointsSeries(login, from, to),
        gained: window === null || closing === null ? null : closing - window.balance,
        // Null for a full window (the label is just the range), the real
        // start when the channel has been tracked for less than it -- so
        // three days under a "30 days" range says "3d" instead of
        // claiming a month of history it does not have.
        gainedSince: window?.ts ?? null,
        events: deps.history.eventsFor(login, 100),
        sessions,
        coverage: {
          live: clip(liveSpans, Math.max(floor, from), to),
          mined: clip(intersect(liveSpans, minerSpans), Math.max(floor, from), to),
        },
        firstSeen,
        // The oldest sample that survived pruning, so the client can say
        // what the window really covers instead of inferring the channel
        // began at the retention cutoff.
        retentionFloor: deps.history.earliestSample(login)?.ts ?? null,
      };
    });

    instance.get("/api/logs", async () => deps.supervisor.logs());

    for (const action of ["start", "stop", "restart"] as const) {
      instance.post(`/api/miner/${action}`, async () => {
        await deps.supervisor[action]();
        // Both values are read after the action settles, so the caller can
        // render the outcome from this response alone and does not have to
        // wait for the next status frame to stop showing the old state.
        return { state: deps.supervisor.state, startedAt: deps.supervisor.runningSince };
      });
    }

    instance.post("/api/twitch/login", async () => {
      deps.loginRunner.start();
      return { started: true };
    });

    /**
     * Drops the stored Twitch session.
     *
     * The counterpart to the login route above, which until now had none:
     * the only way to end a session was to delete the pickle on the host by
     * hand, so an operator who signed in as the wrong account -- or who
     * wants to see the first-run state again -- was stuck.
     *
     * Order matters. The miner is stopped first because it holds the
     * session in memory and rewrites the pickle whenever it refreshes the
     * token: deleting the file under a live miner either sees it written
     * straight back, or leaves the miner mining as the account the user
     * just signed out of.
     *
     * `username` is deliberately left in the config. It is not a
     * credential, and keeping it means signing back in does not start with
     * retyping it -- `/api/status` already reports `loginRequired` from
     * LoginStatus, so the notice appears either way.
     */
    instance.post("/api/twitch/logout", async () => {
      await deps.supervisor.stop();
      // A login attempt still waiting on a device code would write a fresh
      // pickle moments after this one is deleted.
      deps.loginRunner.cancel();

      const { username } = loadConfig(deps.configPath);
      // `force` makes a missing file a no-op: logging out twice, or before
      // ever logging in, is the state the caller asked for, not an error.
      if (username !== "") {
        await rm(join(deps.cookiesDir, `${username}.pkl`), { force: true });
      }

      deps.loginStatus.markLoggedOut();
      pushStatus();
      // The running helper froze the pickle's path at spawn and would keep
      // answering from the session it has already loaded, so the dashboard
      // would go on looking signed in against a cookie that is gone.
      await recycleHelper();
      return { loggedOut: true };
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
    const body = request.body as { event?: unknown; message?: unknown } | undefined;
    const event = body?.event;
    if (typeof event !== "string" || !DOORBELL_EVENT.test(event)) {
      return reply.code(400).send({ error: "event must be an upper snake case name" });
    }
    // A bad message must not cost us the event: the type is what drives the
    // refresh, so an unusable message degrades to null rather than a 400.
    deps.stateService.ring(event, doorbellMessage(body?.message));
    return reply.code(204).send();
  });

  deps.pendingRestart.setBroadcast?.((event, data) => hub.broadcast(event, data));

  deps.stateService.on("change", (snapshot) => hub.broadcast("state", snapshot));
  // The activity feed used to poll /api/events every 5s, which re-sent the
  // same 20 rows forever and still showed a new one up to 5s late. Pushing
  // the row the moment it is recorded means only genuinely new events cross
  // the wire; the client fetches the backlog once on mount.
  deps.stateService.on("event", (row) => hub.broadcast("event", row));
  // New miner output, carrying the buffer's running total so the log view can
  // skip lines it already has and notice any it missed.
  deps.supervisor.on("log", (frame) => hub.broadcast("log", frame));
  // Built at emit time, so the frame carries the start time that belongs to
  // the state being announced: a RUNNING frame gets the new process's
  // timestamp, and a STOPPED/CRASHED frame gets null.
  deps.supervisor.on("state", () => pushStatus());
  deps.loginRunner.on("progress", (p: LoginProgress) => {
    hub.broadcast("login", p);
    if (p.stage !== "ok") return;
    deps.loginStatus.markLoggedIn();
    // The helper reports the login Twitch actually accepted, which is the
    // authority on how the account is spelled. Persisting it before the
    // recycle below matters: helperEnv() in index.ts reads TWITCH_USERNAME
    // out of config.json at spawn time, so a helper started first would
    // keep resolving the old (or empty) cookie pickle path.
    persistUsername(p.username);
    pushStatus();
    // A refresh already in flight when the login completed was answered by
    // the old, signed-out helper. Its 401 arrives after this point and
    // state.py cannot classify it as AUTH -- the new pickle is on disk by
    // then, so the session re-reads as healthy -- leaving a raw GQL
    // traceback on the dashboard of a user who has just successfully
    // signed in. Any error from before this moment is stale by definition.
    deps.stateService.clearError();
    // A completed login writes the cookie pickle the state helper reads,
    // under whatever username the config names now -- neither of which the
    // running helper can see. Fire-and-forget: the SSE frame above must not
    // wait on a process restart.
    void recycleHelper();
    // Start mining now that there is a session to mine with. The config
    // apply path has always assumed this happens ("the miner is started by
    // the login flow once a session exists") but nothing here did it, which
    // went unnoticed while every first login was followed by an apply.
    // Logging out of Twitch stops the miner, so without this a
    // logout/login round trip leaves it stopped with nothing saying why.
    // Same guard the apply path uses: a miner started without an account
    // to mine as exits immediately and parks in CRASHED.
    if (loadConfig(deps.configPath).username !== "") {
      void deps.supervisor.restart().catch(() => {
        // The dashboard reports miner state on its own and offers a Start
        // button; a failure here must not take the login flow down with it.
      });
    }
  });

  // A helper response carrying code "AUTH" means state.py reloaded the
  // cookie pickle and still could not authenticate: the session is gone,
  // whatever a past login attempt reported. Both paths a rejected request
  // can take are covered -- one attributed to a caller (StateService's
  // refresh) and one that could not be attributed to any single request.
  deps.stateService.on("auth-error", () => {
    deps.loginStatus.markLoggedOut();
    pushStatus();
  });
  deps.helper.on("unattributed-error", (error: unknown) => {
    if (error instanceof NdjsonError && error.code === "AUTH") {
      deps.loginStatus.markLoggedOut();
      pushStatus();
    }
  });

  // The state service consults this to decide whether a refresh needs its
  // display half. A getter rather than a snapshot value: buildServer is
  // called once, and the count changes for the life of the process.
  Object.defineProperty(app, "clientCount", {
    get: () => hub.clientCount,
    configurable: true,
  });

  return app as unknown as AppServer;
}
