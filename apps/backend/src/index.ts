/**
 * Composition root: builds every long-lived object and starts listening.
 *
 * Nothing here is imported by tests -- it exists to wire the modules the
 * rest of the backend keeps decoupled, so keep logic out of it.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolvePythonBin } from "./config/pythonBin.js";
import { resolveStopGraceMs } from "./config/stopGrace.js";
import { loadConfig } from "./config/store.js";
import { History } from "./db/history.js";
import { openDb } from "./db/schema.js";
import { LoginRunner } from "./helpers/loginRunner.js";
import { LoginStatus } from "./helpers/loginStatus.js";
import { NdjsonClient } from "./helpers/ndjsonClient.js";
import { buildServer } from "./http/server.js";
import { Supervisor } from "./miner/supervisor.js";
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
const supervisor = new Supervisor({
  command: python,
  args: [join(pythonDir, "run.py")],
  cwd: dataDir,
  env: {
    PYTHONPATH: pythonPath,
    MINER_CONFIG: configPath,
    DOORBELL_TOKEN: doorbellToken,
    DOORBELL_URL: `http://127.0.0.1:${port}/internal/doorbell`,
  },
  graceMs: resolveStopGraceMs(process.env.MINER_STOP_GRACE_MS),
});
const db = openDb(join(dataDir, "history.db"));
const history = new History(db);
const stateService = new StateService({
  client: helper,
  history,
  getStreamers: () =>
    loadConfig(configPath).streamers.filter((s) => s.enabled).map((s) => s.username),
});

const staticRoot = resolve(process.env.STATIC_ROOT ?? "./public");

// `loginRequired` used to be derived purely from `loginRunner.current` --
// the progress of a login attempt made by *this* process -- which reads
// `true` for a genuinely logged-in user after every restart (nothing in
// this process has attempted a login yet) and `false` forever once any
// attempt succeeded, even long after the session it produced has expired.
// LoginStatus is the single source of truth instead, seeded below from the
// boot check_login round trip and kept current afterwards by AUTH errors
// (wired inside buildServer).
const loginStatus = new LoginStatus();

const app = buildServer({
  configPath, password, doorbellToken, supervisor, stateService, history,
  helper, loginRunner, loginStatus, staticRoot,
});

const loggedIn = await helper
  .request<{ loggedIn: boolean }>("check_login")
  .catch(() => ({ loggedIn: false }));
if (loggedIn.loggedIn) loginStatus.markLoggedIn();

stateService.start();
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
