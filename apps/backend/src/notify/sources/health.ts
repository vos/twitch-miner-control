import type { EventEmitter } from "node:events";
import type { UpdateChecker } from "../../config/updateCheck.js";
import type { LoginStatus } from "../../helpers/loginStatus.js";
import type { CrashInfo, MinerState } from "../../miner/supervisor.js";
import { NOTIFY_KIND, type PublishInput } from "../catalogue.js";
import type { Notifier } from "../notifier.js";

/** One tag for the whole group, so a crash loop replaces one notification instead of stacking them. */
const TAG = "miner-health";
const RELEASE_URL = "https://github.com/vos/twitch-miner-control/releases/tag/v";

function duration(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

const exitCode = (code: number | null) => (code === null ? "" : ` with code ${code}`);

export function crashNotification(info: CrashInfo): PublishInput {
  const base = { kind: NOTIFY_KIND.MINER_CRASHED, tag: TAG, link: "/?open=logs" } as const;
  switch (info.kind) {
    case "backoff":
      return {
        ...base,
        title: "Miner crashed",
        // The supervisor gives up once the count passes maxRestarts.
        body: `It exited${exitCode(info.code)} and restarts in ${duration(info.delayMs)} `
          + `(crash ${info.crashCount}; it stops retrying after ${info.maxRestarts + 1}).`,
      };
    case "gaveUp":
      return {
        ...base,
        title: "Miner stopped after repeated crashes",
        body: `${info.crashCount} crashes in ${duration(info.windowMs)}, so it is no longer `
          + "restarted. Check the Logs page, then start it again.",
      };
    case "unstartable":
      return {
        ...base,
        title: "Miner can't start",
        body: info.uptimeMs < 1000
          ? `It exited${exitCode(info.code)} within a second of starting, so the config or `
            + "environment is broken. Check the Logs page."
          : `It exited${exitCode(info.code)} after only ${duration(info.uptimeMs)}, so the config `
            + "or environment is broken. Check the Logs page.",
      };
    case "spawnFailed":
      return { ...base, title: "Miner can't start", body: `It could not be launched: ${info.err}` };
  }
}

export interface HealthDeps {
  notifier: Pick<Notifier, "publish">;
  supervisor: Pick<EventEmitter, "on">;
  loginStatus: Pick<LoginStatus, "onSignedOut">;
  updates: Pick<UpdateChecker, "onAvailable" | "available">;
}

export function watchHealth(deps: HealthDeps): void {
  const { notifier } = deps;

  // Set by a crash and cleared once the miner runs or is stopped on
  // purpose, so only a recovery from a crash is announced.
  let crashed = false;
  deps.supervisor.on("crash", (info: CrashInfo) => {
    crashed = true;
    notifier.publish(crashNotification(info));
  });
  deps.supervisor.on("state", (state: MinerState) => {
    if (state === "RUNNING" && crashed) {
      notifier.publish({
        kind: NOTIFY_KIND.MINER_RECOVERED, title: "Miner running again",
        body: "It recovered after a crash.", tag: TAG, link: "/?open=dashboard",
      });
    }
    if (state === "RUNNING" || state === "STOPPED") crashed = false;
  });

  deps.loginStatus.onSignedOut(() => {
    notifier.publish({
      kind: NOTIFY_KIND.TWITCH_SIGNED_OUT, title: "Twitch sign-in needed",
      body: "Twitch rejected the stored session. Sign in again to keep mining.",
      link: "/?open=account",
    });
  });

  const announce = (version: string) => notifier.publish({
    kind: NOTIFY_KIND.APP_UPDATE, title: "Update available",
    body: `Version ${version} is out.`,
    link: `${RELEASE_URL}${version}`,
    dedupeKey: `app.update:${version}`,
  });
  deps.updates.onAvailable(announce);
  // A check that finished before this ran would otherwise go unannounced;
  // the dedupe key stops a repeat.
  if (deps.updates.available !== null) announce(deps.updates.available);
}
