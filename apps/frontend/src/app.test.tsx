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
  expect(await screen.findByTestId("miner-uptime")).toHaveTextContent("1m 30s");
});
