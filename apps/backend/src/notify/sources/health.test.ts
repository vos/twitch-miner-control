import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { UpdateChecker } from "../../config/updateCheck.js";
import { LoginStatus } from "../../helpers/loginStatus.js";
import { crashNotification, watchHealth } from "./health.js";

function harness(available: string | null = null) {
  const publish = vi.fn();
  const supervisor = new EventEmitter();
  const loginStatus = new LoginStatus();
  const updates = new UpdateChecker({ current: "1.1.0", fetchImpl: vi.fn() });
  updates.available = available;
  watchHealth({ notifier: { publish }, supervisor, loginStatus, updates });
  return { publish, supervisor, loginStatus, updates };
}

test("a crash is published with what happens next, tagged to replace the last one", () => {
  const { publish, supervisor } = harness();
  supervisor.emit("crash", { kind: "backoff", code: 1, delayMs: 8_000, crashCount: 2, maxRestarts: 5 });
  expect(publish).toHaveBeenCalledWith({
    kind: "miner.crashed", tag: "miner-health", link: "/?open=logs",
    title: "Miner crashed",
    body: "It exited with code 1 and restarts in 8 s (crash 2; it stops retrying after 6).",
  });
});

test("each crash kind reads differently", () => {
  expect(crashNotification({ kind: "gaveUp", crashCount: 6, windowMs: 3_600_000 }).title)
    .toBe("Miner stopped after repeated crashes");
  expect(crashNotification({ kind: "unstartable", code: 1, uptimeMs: 300 }).body)
    .toContain("config or environment is broken");
  expect(crashNotification({ kind: "spawnFailed", err: "ENOENT" }).body).toContain("ENOENT");
});

test("an unstartable crash within a second of starting reads as too fast to be a fluke", () => {
  expect(crashNotification({ kind: "unstartable", code: 1, uptimeMs: 300 }).body).toBe(
    "It exited with code 1 within a second of starting, so the config or environment "
    + "is broken. Check the Logs page.",
  );
});

test("an unstartable crash after longer than a second reads with its duration", () => {
  expect(crashNotification({ kind: "unstartable", code: 1, uptimeMs: 4_000 }).body).toBe(
    "It exited with code 1 after only 4 s, so the config or environment is broken. "
    + "Check the Logs page.",
  );
});

test("recovery is announced only after a crash", () => {
  const { publish, supervisor } = harness();
  supervisor.emit("state", "RUNNING");
  expect(publish).not.toHaveBeenCalled();
  supervisor.emit("crash", { kind: "backoff", code: 1, delayMs: 1_000, crashCount: 1, maxRestarts: 5 });
  supervisor.emit("state", "RESTARTING");
  supervisor.emit("state", "RUNNING");
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({
    kind: "miner.recovered", tag: "miner-health",
  }));
  supervisor.emit("state", "STOPPED");
  supervisor.emit("state", "RUNNING");
  expect(publish).toHaveBeenCalledTimes(2);
});

test("a rejected Twitch session is published", () => {
  // markRejected(), not markLoggedOut() -- this is the AUTH-error path;
  // a plain sign-out is silent (see loginStatus.test.ts).
  const { publish, loginStatus } = harness();
  loginStatus.markLoggedIn();
  loginStatus.markRejected();
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({
    kind: "twitch.signedOut", link: "/?open=account",
  }));
});

test("an update is published once per version, including one found before wiring", () => {
  const { publish } = harness("1.2.0");
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({
    kind: "app.update", dedupeKey: "app.update:1.2.0",
    link: "https://github.com/vos/twitch-miner-control/releases/tag/v1.2.0",
  }));
});
