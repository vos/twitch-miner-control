import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./app.js";

// I3: `/api/status` already reports `loginRequired` correctly (see
// apps/backend/src/http/server.ts and helpers/loginStatus.ts), but nothing
// in the frontend read it -- an expired token showed up as a stale
// dashboard with a bare GQL error string and no call to action.

function stub(loginRequired: boolean) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/status") {
      return {
        ok: true, status: 200,
        json: async () => ({ miner: "RUNNING", loginRequired, login: null }),
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

const view = () => render(<MantineProvider><App /></MantineProvider>);

test("shows a sign-in prompt when the Twitch session needs attention", async () => {
  stub(true);
  view();
  expect(await screen.findByTestId("login-required-banner")).toBeInTheDocument();
});

test("hides the sign-in prompt once a Twitch session is established", async () => {
  stub(false);
  view();
  // Let the app settle (the dashboard renders regardless of login state)
  // before asserting the banner's absence, so this isn't trivially true of
  // an unrendered tree.
  await screen.findByText("Dashboard");
  expect(screen.queryByTestId("login-required-banner")).not.toBeInTheDocument();
});

test("clicking Sign in from the banner switches to the Twitch account screen", async () => {
  stub(true);
  view();
  await userEvent.click(await screen.findByRole("button", { name: /sign in/i }));
  expect(await screen.findByRole("heading", { name: /twitch account/i })).toBeInTheDocument();
});
