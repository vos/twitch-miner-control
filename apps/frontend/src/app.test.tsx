import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./app.js";
import { renderApp } from "./test-utils.js";

// I3: `/api/status` already reports `loginRequired` correctly (see
// apps/backend/src/http/server.ts and helpers/loginStatus.ts), but nothing
// in the frontend read it -- an expired token showed up as a stale
// dashboard with a bare GQL error string and no call to action.

function stub(loginRequired: boolean) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/status") {
      return {
        ok: true, status: 200,
        json: async () => ({
          miner: "RUNNING", loginRequired, login: null,
          startedAt: Date.now() - 90_000,
        }),
      };
    }
    // PasswordGate's own unlock check, and whatever the active screen
    // (Dashboard by default) fetches -- neither is under test here, so a
    // single generic-enough stub covers both.
    return {
      ok: true, status: 200,
      json: async () => ({ streamers: [], lastUpdated: null, stale: true, error: null }),
    };
  }));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

const view = () => renderApp(<App />);

test("flags the account nav row when the Twitch session needs attention", async () => {
  // Replaces the old banner above every screen: the nav says it
  // permanently, without eating dashboard height.
  stub(true);
  view();
  expect(await screen.findByTestId("nav-login-required")).toBeInTheDocument();
});

test("leaves the account row unflagged once a Twitch session is established", async () => {
  stub(false);
  view();
  // Let the app settle before asserting absence, so this isn't trivially
  // true of an unrendered tree.
  await screen.findByRole("button", { name: /dashboard/i });
  expect(screen.queryByTestId("nav-login-required")).not.toBeInTheDocument();
});

test("the account nav row switches to the Twitch account screen", async () => {
  stub(true);
  view();
  await userEvent.click(await screen.findByRole("button", { name: /twitch account/i }));
  expect(await screen.findByLabelText("Twitch username")).toBeInTheDocument();
});

test("shows the live-updates connection state in the header", async () => {
  // useLiveState has always computed `connected` from EventSource's own
  // lifecycle, and nothing read it -- so a dropped stream looked exactly
  // like a healthy one. The stub never fires "open", which is the
  // disconnected case.
  stub(false);
  view();
  expect(await screen.findByLabelText(/live updates disconnected/i)).toBeInTheDocument();
});

test("the miner actions live in the sidebar dock, beside the header's badge", async () => {
  // The split from Task 4: the header states status, the dock acts on it.
  stub(false);
  view();
  expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
  expect(screen.getByTestId("miner-state")).toHaveTextContent("RUNNING");
});

test("the header shows how long the miner has been up", async () => {
  stub(false);
  view();
  // "1m30s": the header welds each number to its unit so the readout's
  // figures read as separate objects -- see MinerStatusBadge.
  expect(await screen.findByTestId("miner-uptime")).toHaveTextContent("1m30s");
});

test("the dashboard carries the sign-in notice when Twitch login is required", async () => {
  // The sidebar dot is a two-pixel hint with no label; someone who has
  // never used the app has no way to read it as "you must sign in first".
  stub(true);
  view();
  expect(await screen.findByTestId("login-required-notice")).toBeInTheDocument();
});

test("holds the notice back until /api/status has actually answered", async () => {
  // `loginRequired` starts true to match the server's default-to-required
  // stance, so rendering straight off that state would flash the notice at
  // every signed-in user on every load.
  // PasswordGate probes /api/status too, and it has to succeed or the
  // gate never unlocks and there is no dashboard to assert about. So the
  // first probe answers and every later one -- App's own poll -- hangs,
  // leaving `loginRequired` on its unproven initial value.
  let probed = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/status") {
      if (probed) return await new Promise(() => {});
      probed = true;
      return {
        ok: true, status: 200,
        json: async () => ({ miner: "RUNNING", loginRequired: true, login: null,
          startedAt: null, stats: null }),
      };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ streamers: [], lastUpdated: null, stale: true, error: null }),
    };
  }));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
  view();
  await screen.findByRole("button", { name: /dashboard/i });
  expect(screen.queryByTestId("login-required-notice")).not.toBeInTheDocument();
});

test("the notice leads to the Twitch account screen", async () => {
  stub(true);
  view();
  await userEvent.click(await screen.findByRole("button", { name: /sign in to twitch/i }));
  expect(await screen.findByLabelText("Twitch username")).toBeInTheDocument();
});
