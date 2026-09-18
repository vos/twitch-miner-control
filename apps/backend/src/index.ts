/**
 * Composition root: builds every long-lived object and starts listening.
 *
 * Nothing here is imported by tests -- it exists to wire the modules the
 * rest of the backend keeps decoupled, so keep logic out of it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePythonBin } from "./config/pythonBin.js";
import { resolveStopGraceMs } from "./config/stopGrace.js";
import { resolveEnvFlag } from "./config/envFlag.js";
import { resolveMinerLogLevel } from "./config/logLevel.js";
import { resolveRetentionDays } from "./config/retention.js";
import { loadConfig, saveConfig } from "./config/store.js";
import { History } from "./db/history.js";
import { openDb } from "./db/schema.js";
import { Streamers } from "./db/streamers.js";
import { LoginRunner } from "./helpers/loginRunner.js";
import { LoginStatus } from "./helpers/loginStatus.js";
import { NdjsonClient } from "./helpers/ndjsonClient.js";
import { buildServer, updateChecker, type AppServer } from "./http/server.js";
import { Supervisor } from "./miner/supervisor.js";
import { ProfileCache } from "./state/profiles.js";
import { SubscriptionEngine } from "./drops/engine.js";
import type { DirectoryChannel } from "./drops/resolution.js";
import { PendingRestart } from "./drops/pendingRestart.js";
import { CampaignCatalogue } from "./state/campaignCatalogue.js";
import { DropsCache } from "./state/drops.js";
import { dropsEligible } from "./state/dropsEligible.js";
import { normaliseUsername, resolveRoster } from "./state/roster.js";
import { InventoryCache } from "./state/inventory.js";
import { StateService } from "./state/service.js";

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const pythonDir = resolve(process.env.PYTHON_DIR ?? "./python");
const vendorDir = resolve(process.env.MINER_DIR ?? join(pythonDir, "..", "vendor", "miner"));
const python = resolvePythonBin(process.env.PYTHON_BIN);
const configPath = join(dataDir, "config.json");
const cookiesDir = join(dataDir, "cookies");
const password = process.env.APP_PASSWORD;
if (!password) throw new Error("APP_PASSWORD is required");
const doorbellToken = randomBytes(24).toString("hex");
const port = Number(process.env.PORT ?? 8080);

// The miner resolves cookies relative to its CWD, so every child shares
// dataDir as its working directory -- and it has to exist before SQLite
// opens a file in it or the first login writes a pickle under it.
mkdirSync(cookiesDir, { recursive: true });

/**
 * `python/helpers/state.py` imports TwitchChannelPointsMiner at module
 * level but only extends sys.path inside main(), so it cannot be spawned
 * as a script without the vendored miner already on the path. Exporting
 * PYTHONPATH here makes every child resolve both `helpers.*` and the
 * vendored package regardless of which file is the entry point.
 */
const pythonPath = [pythonDir, vendorDir, process.env.PYTHONPATH]
  .filter(Boolean)
  .join(":");

/**
 * Environment shared by both Python helpers.
 *
 * TWITCH_USERNAME is a live accessor, not a snapshot: `helpers/_session.py`
 * derives the cookie pickle's filename from it (`{username}.pkl`), and the
 * username is not known on a first run -- the user types it into the config
 * before logging in. A value captured at boot would send the login helper's
 * cookies to the wrong file and leave the state helper reading an empty
 * session forever. NdjsonClient, LoginRunner and Supervisor all spread
 * `options.env` inside spawn(), so the accessor is read once per child
 * process. It must be defined on the object handed to the runner -- copying
 * this object anywhere would freeze the value at copy time.
 */
function helperEnv(): Record<string, string> {
  const env: Record<string, string> = {
    COOKIES_DIR: cookiesDir,
    PYTHONPATH: pythonPath,
  };
  Object.defineProperty(env, "TWITCH_USERNAME", {
    enumerable: true,
    get: () => loadConfig(configPath).username,
  });
  return env;
}

const helper = new NdjsonClient({
  command: python,
  args: [join(pythonDir, "helpers", "state.py")],
  cwd: dataDir,
  env: helperEnv(),
});
const loginRunner = new LoginRunner({
  command: python,
  args: [join(pythonDir, "helpers", "login.py")],
  cwd: dataDir,
  env: helperEnv(),
});
const db = openDb(join(dataDir, "history.db"));
const history = new History(db);
// Close spans left open by a killed process before anything reads one.
// An open miner session claims the miner is still running, so a crash
// would otherwise keep accruing mining time for the whole downtime.
history.recoverOpenSessions();

// point_snapshots is the only table that grows per tick. The session
// tables are deliberately never pruned: they are tiny, and they are the
// source of the all-time mining figure.
const retentionDays = resolveRetentionDays(process.env.HISTORY_RETENTION_DAYS);
if (retentionDays > 0) {
  const prune = () => {
    const removed = history.prunePoints(Date.now() - retentionDays * 86_400_000);
    // VACUUM only when something was actually deleted: it rewrites the
    // whole file, which is not worth doing daily to reclaim nothing.
    if (removed > 0) {
      console.log(`pruned ${removed} point snapshots older than ${retentionDays}d`);
      db.exec("VACUUM");
    }
  };
  prune();
  // unref() so a pending prune never holds the process open at shutdown.
  setInterval(prune, 86_400_000).unref();
}

// Asked once at boot and daily after, so the sidebar can point at a newer
// release. Failures are silent by design (see UpdateChecker): this drives
// a decorative badge and must never be a reason the server misbehaves.
// A dev build skips the request entirely, so `pnpm dev` stays offline.
void updateChecker.check();
// unref() so a pending check never holds the process open at shutdown --
// the same reason the retention prune above does it.
setInterval(() => void updateChecker.check(), 86_400_000).unref();

const supervisor = new Supervisor({
  command: python,
  args: [join(pythonDir, "run.py")],
  cwd: dataDir,
  env: {
    PYTHONPATH: pythonPath,
    MINER_CONFIG: configPath,
    DOORBELL_TOKEN: doorbellToken,
    DOORBELL_URL: `http://127.0.0.1:${port}/internal/doorbell`,
    // Upstream writes its log file at DEBUG by default, which is almost
    // entirely websocket keepalives and connection-pool chatter; see
    // config/logLevel.ts. Only the file level is configurable -- the
    // console stays at INFO because that is what the supervisor captures
    // for the Logs page.
    MINER_LOG_LEVEL: resolveMinerLogLevel(process.env.MINER_LOG_LEVEL),
  },
  graceMs: resolveStopGraceMs(process.env.MINER_STOP_GRACE_MS),
  // Uptime spans, so "the channel was live" and "we were mining it" stay
  // distinguishable on the cards.
  sessions: {
    open: (ts) => history.openMinerSession(ts),
    close: (ts) => history.closeMinerSession(ts),
  },
});
/**
 * Wires the roster resolver to this process's config and helper. The union,
 * dedupe and failure handling live in state/roster.ts, where they are
 * unit-tested; see that module for why the backend refetches the follow
 * list rather than sharing the miner's copy.
 */
function resolveStreamers(): Promise<string[]> {
  return resolveRoster({
    configured: () =>
      loadConfig(configPath).streamers.filter((s) => s.enabled).map((s) => s.username),
    followersEnabled: () => loadConfig(configPath).followers,
    fetchFollowers: async () =>
      (await helper.request<{ followers: string[] }>("followers")).followers,
    onError: (cause) => console.warn("could not load followed channels:", cause),
  });
}

/**
 * The campaign label for a subscription-owned channel, or null.
 *
 * Matched case-insensitively: the engine writes whatever login the
 * directory reported, while the roster and the dashboard normalise, so a
 * literal comparison would silently drop the badge on any channel whose
 * capitalisation happens to differ.
 */
function subscriptionLabelFor(username: string): string | null {
  const config = loadConfig(configPath);
  const key = normaliseUsername(username);
  const entry = config.streamers.find(
    (s) => normaliseUsername(s.username) === key,
  );
  if (entry?.ownedBy === undefined) return null;
  return config.subscriptions.find((sub) => sub.id === entry.ownedBy)?.label ?? null;
}

const streamers = new Streamers(db);
const profileCache = new ProfileCache({ streamers, client: helper });

// Config is re-read per call rather than captured: toggling claimDrops
// must take effect on the next pass, not at the next restart.
const dropsCache = new DropsCache({
  client: helper,
  eligible: (login) => dropsEligible(loadConfig(configPath), login),
});

/**
 * Set once buildServer has run, below. The state service is constructed
 * first -- the server takes it as a dependency -- so the connection count
 * it needs cannot be read directly at this point; this holder closes the
 * cycle without making either side optional.
 */
let server: AppServer | null = null;

/**
 * Forces the boot refresh to derive its display fields even though no
 * client can possibly be connected yet.
 *
 * So that the numbers are ready and waiting: whoever opens the dashboard
 * first is then served from memory instead of paying for a state pass
 * that could have run while the process was starting anyway. The pass is
 * one this process makes regardless -- the idle path would still write
 * every history row -- so deriving on top of it costs only the profile
 * and drops lookups.
 *
 * Cleared when that refresh settles, not when it is issued: `start()`
 * awaits a helper round trip, so the pass is still in flight long after
 * the statement that began it returned.
 */
let booting = true;

const stateService = new StateService({
  client: helper,
  history,
  streamers,
  getStreamers: resolveStreamers,
  ownerLabel: subscriptionLabelFor,
  profiles: profileCache,
  drops: dropsCache,
  // This process normally runs for days with no browser attached. A
  // refresh with nobody watching still writes the full history (points,
  // sessions, the miner heartbeat) and then stops before the profile and
  // drops round trips and the per-streamer derivation, all of which only
  // feed a frame nobody would receive. See StateServiceDeps.
  //
  // `booting` covers the first pass, which is in flight before any
  // client could exist; after that it is purely the live count.
  clientsConnected: () => booting || (server?.clientCount ?? 0) > 0,
});

const staticRoot = resolve(process.env.STATIC_ROOT ?? "./public");
// Checked once at boot purely so the startup log can say which of the two
// modes this process is in. buildServer does its own check.
const staticRootExists = existsSync(staticRoot);

// `loginRequired` used to be derived purely from `loginRunner.current` --
// the progress of a login attempt made by *this* process -- which reads
// `true` for a genuinely logged-in user after every restart (nothing in
// this process has attempted a login yet) and `false` forever once any
// attempt succeeded, even long after the session it produced has expired.
// LoginStatus is the single source of truth instead, seeded below from the
// boot check_login round trip and kept current afterwards by AUTH errors
// (wired inside buildServer).
const loginStatus = new LoginStatus();

// Both default off, for the documented LAN-over-HTTP deployment. A reverse
// proxy terminating TLS wants them on together: SECURE_COOKIE stops the
// session cookie from ever crossing a plaintext hop, and TRUST_PROXY makes
// the login limiter count real client addresses rather than seeing every
// request arrive from the proxy itself. See .env.example.
const secureCookie = resolveEnvFlag(process.env.SECURE_COOKIE);
const trustProxy = resolveEnvFlag(process.env.TRUST_PROXY);

// Two sources, deliberately split. The campaign list comes from a public
// tracker over plain HTTPS (see campaignSource.ts: Twitch's own dashboard
// query is behind Kasada bot detection and cannot be reached from a
// script), while progress still comes from Twitch through the helper --
// the Inventory query is not gated and uses the session we already hold.
//
// The catalogue outlives a restart on purpose, since campaign metadata
// stays true across one; progress does not, and lives only in memory.
const catalogue = new CampaignCatalogue({
  path: join(dataDir, "campaigns.json"),
});
const inventoryCache = new InventoryCache({ client: helper });

// The engine restarts the miner when a subscription resolves to
// different channels, so the restart is deferred behind a cancellable
// countdown rather than interrupting whoever is watching. buildServer
// attaches its SSE hub to this, the hub being inside the server.
const pendingRestart = new PendingRestart({ supervisor });

const engine = new SubscriptionEngine({
  loadConfig: () => loadConfig(configPath),
  saveConfig,
  configPath,
  catalogue,
  directory: (game) =>
    helper.request<{ channels: DirectoryChannel[] }>("directory", {
      game: game.name, slug: game.slug, limit: 30,
    }).then((r) => r.channels),
  pending: pendingRestart,
});

const app: AppServer = buildServer({
  configPath, password, doorbellToken, supervisor, stateService, history,
  streamers,
  helper, loginRunner, loginStatus, cookiesDir, staticRoot, secureCookie, trustProxy,
  catalogue, inventory: inventoryCache,
  engine, pendingRestart,
});

const loggedIn = await helper
  .request<{ loggedIn: boolean }>("check_login")
  .catch(() => ({ loggedIn: false }));
if (loggedIn.loggedIn) loginStatus.markLoggedIn();

server = app;
// Derives in full, then hands over to the live client count: from the
// next poll on, a refresh with nobody watching writes history and skips
// the display half.
void stateService.start().finally(() => { booting = false; });
// Started after the miner, so the first pass does not race the boot
// restart. A pass with no subscriptions returns immediately.
engine.start();
if (loggedIn.loggedIn && loadConfig(configPath).username) await supervisor.start();

// Children are not killed when this process exits, so a SIGTERM from a
// service manager would otherwise orphan the miner and both helpers --
// and an orphaned miner keeps mining against a config nobody can change.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      stateService.stop();
      engine.stop();
      // cancel() itself is synchronous (it only sends signals and arms its
      // own SIGKILL escalation timer), so awaiting it directly awaited
      // nothing -- process.exit(0) below could run before the SIGKILL
      // timer ever fired, orphaning a login helper that ignored SIGTERM.
      // `running` is checked before cancel() (both synchronous, so there
      // is no race) to avoid waiting on a "done" that will never come when
      // no login was ever started.
      const loginDone = loginRunner.running
        ? new Promise<void>((resolve) => loginRunner.once("done", () => resolve()))
        : Promise.resolve();
      loginRunner.cancel();
      await Promise.allSettled([
        supervisor.stop(), helper.stop(), app.close(), loginDone,
      ]);
      db.close();
      process.exit(0);
    })();
  });
}

await app.listen({ port, host: "0.0.0.0" });

// After listen resolves, so this reports a port actually bound rather than
// one we merely asked for -- an EADDRINUSE rejects above and never gets
// here. Fastify runs with `logger: false`, so without this the process
// prints nothing at all on a successful start and a healthy server is
// indistinguishable from one that died on boot.
console.log(`listening on http://localhost:${port}`);
console.log(
  staticRootExists
    ? `serving the frontend from ${staticRoot}`
    // Worth saying plainly: the API works but the browser gets a 404 at
    // the root, which otherwise looks like the server failing entirely.
    : `no frontend at ${staticRoot} -- API only (run \`pnpm build\` first)`,
);
