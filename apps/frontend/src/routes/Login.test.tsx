import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TwitchLogin } from "./Login.js";
import { renderApp } from "../test-utils.js";

function stub(status: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => status,
  })));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

const view = () => renderApp(<TwitchLogin />);

test("offers to start login when there is no session", async () => {
  stub({ login: null, miner: "STOPPED" });
  view();
  expect(await screen.findByRole("button", { name: /sign in to twitch/i })).toBeInTheDocument();
});

test("displays the device code and activation link", async () => {
  stub({ login: { stage: "code", userCode: "ABCD1234",
                  verificationUri: "https://www.twitch.tv/activate", expiresAt: 1 } });
  view();
  expect(await screen.findByText("ABCD1234")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /twitch.tv\/activate/i })).toHaveAttribute(
    "href", "https://www.twitch.tv/activate",
  );
});

test("shows waiting state while the code is pending", async () => {
  stub({ login: { stage: "pending" } });
  view();
  expect(await screen.findByText(/waiting/i)).toBeInTheDocument();
});

test("confirms a completed login", async () => {
  stub({ login: { stage: "ok", username: "alex" } });
  view();
  expect(await screen.findByText(/signed in as alex/i)).toBeInTheDocument();
});

test("surfaces a login error", async () => {
  stub({ login: { stage: "error", error: "code expired, start again" } });
  view();
  expect(await screen.findByRole("alert")).toHaveTextContent("code expired");
});

test("starting login posts to the API", async () => {
  // A username is a precondition for login now: the helper reads it from
  // the stored config when it spawns, so the button stays inert without one.
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.startsWith("/api/config")
      ? { version: 1, username: "alex", followers: false, followersOrder: "ASC",
          defaults: {}, streamers: [] }
      : { login: null }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  view();
  await screen.findByDisplayValue("alex");
  await userEvent.click(await screen.findByRole("button", { name: /sign in to twitch/i }));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/twitch/login")).toBe(true);
});

/** Routes by URL so the component can read /api/config and write it back. */
function stubRoutes(status: unknown, config: Record<string, unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = url.startsWith("/api/config") ? config : status;
    return { ok: true, status: 200, json: async () => body };
  }));
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  return calls;
}

const CONFIG = {
  version: 1, username: "", followers: false, followersOrder: "ASC",
  defaults: {}, streamers: [],
};

test("offers a username field when no Twitch account is set", async () => {
  stubRoutes({ login: null }, CONFIG);
  view();
  expect(await screen.findByLabelText(/twitch username/i)).toBeInTheDocument();
});

test("shows the already-configured username", async () => {
  stubRoutes({ login: null }, { ...CONFIG, username: "alex" });
  view();
  expect(await screen.findByLabelText(/twitch username/i)).toHaveValue("alex");
});

test("saves the username to the config before starting login", async () => {
  const calls = stubRoutes({ login: null }, CONFIG);
  view();
  await userEvent.type(await screen.findByLabelText(/twitch username/i), "alex");
  await userEvent.click(screen.getByRole("button", { name: /sign in to twitch/i }));
  const put = calls.find((c) => c.url === "/api/config" && c.init?.method === "PUT");
  expect(put).toBeDefined();
  expect(JSON.parse(String(put?.init?.body)).username).toBe("alex");
  // The username has to reach the helper's environment before it spawns.
  const putIndex = calls.indexOf(put!);
  const loginIndex = calls.findIndex((c) => c.url === "/api/twitch/login");
  expect(putIndex).toBeLessThan(loginIndex);
});

test("rejects a malformed username without calling the API", async () => {
  const calls = stubRoutes({ login: null }, CONFIG);
  view();
  await userEvent.type(await screen.findByLabelText(/twitch username/i), "no");
  await userEvent.click(screen.getByRole("button", { name: /sign in to twitch/i }));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(calls.some((c) => c.url === "/api/twitch/login")).toBe(false);
});

test("does not start login with an empty username", async () => {
  const calls = stubRoutes({ login: null }, CONFIG);
  view();
  await userEvent.click(await screen.findByRole("button", { name: /sign in to twitch/i }));
  expect(calls.some((c) => c.url === "/api/twitch/login")).toBe(false);
});

test("keeps the code on screen while polling is pending", async () => {
  // Pending frames carry the code fields precisely so the user can keep
  // reading the code while the helper polls.
  stub({ login: { stage: "pending", userCode: "ABCD1234",
                  verificationUri: "https://www.twitch.tv/activate", expiresAt: 1 } });
  view();
  expect(await screen.findByText("ABCD1234")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /twitch.tv\/activate/i })).toBeInTheDocument();
  expect(screen.getByText(/waiting/i)).toBeInTheDocument();
});

test("counts down how long the device code stays valid", async () => {
  // expiresAt was fetched and never shown, so a dead code looked exactly
  // like a fresh one.
  stub({
    login: {
      stage: "code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://www.twitch.tv/activate",
      expiresAt: Date.now() + 300_000,
    },
  });
  view();
  expect(await screen.findByTestId("code-countdown")).toHaveTextContent(/4:5\d|5:00/);
});

test("says so plainly once the code has expired", async () => {
  stub({
    login: {
      stage: "code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://www.twitch.tv/activate",
      expiresAt: 1,
    },
  });
  view();
  expect(await screen.findByTestId("code-countdown")).toHaveTextContent(/expired/i);
});

// -- logging out of Twitch --------------------------------------------------
// The page could start a session but never end one, so an operator signed in
// as the wrong account had to delete the cookie pickle on the host by hand.

/**
 * Keyed on `loginRequired`, not on `login`: the latter is the progress of a
 * login attempt *this backend process* made, so it is null after every
 * restart even when the stored session is perfectly good -- the button would
 * vanish for exactly the long-lived sessions most likely to need dropping.
 */
function stubSignedIn(loginRequired = false) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === "/api/status") {
      return { ok: true, status: 200,
        json: async () => ({ login: null, miner: "RUNNING", loginRequired }) };
    }
    if (url === "/api/config") {
      return { ok: true, status: 200,
        json: async () => ({ version: 1, username: "alex", followers: true,
          followersOrder: "ASC", defaults: {}, streamers: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ loggedOut: true }) };
  }));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
  return calls;
}

test("offers to log out of Twitch when a session is stored", async () => {
  stubSignedIn();
  view();
  expect(await screen.findByRole("button", { name: /log out of twitch/i }))
    .toBeInTheDocument();
});

test("does not offer to log out when there is no Twitch session", async () => {
  stubSignedIn(true);
  view();
  await screen.findByRole("button", { name: /sign in to twitch/i });
  expect(screen.queryByRole("button", { name: /log out of twitch/i }))
    .not.toBeInTheDocument();
});

test("asks for confirmation before dropping the Twitch session", async () => {
  // One stray click stops the miner and deletes the credentials, so the
  // first click only arms the action.
  const calls = stubSignedIn();
  view();
  await userEvent.click(await screen.findByRole("button", { name: /log out of twitch/i }));
  expect(calls.filter((c) => c.includes("/api/twitch/logout"))).toHaveLength(0);
  expect(await screen.findByRole("button", { name: /confirm/i })).toBeInTheDocument();
});

test("logs out of Twitch once the action is confirmed", async () => {
  const calls = stubSignedIn();
  view();
  await userEvent.click(await screen.findByRole("button", { name: /log out of twitch/i }));
  await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));
  expect(calls).toContain("POST /api/twitch/logout");
});

test("says the miner stops, so the consequence is not a surprise", async () => {
  stubSignedIn();
  view();
  await userEvent.click(await screen.findByRole("button", { name: /log out of twitch/i }));
  expect(await screen.findByTestId("logout-warning")).toHaveTextContent(/miner/i);
});

test("does not offer to sign in while a Twitch session is already stored", async () => {
  // `idle` is true whenever no login attempt is in flight, which includes a
  // signed-in user after a backend restart -- so the sign-in form used to
  // sit directly under the log-out card, inviting a user who is already
  // signed in to sign in again.
  stubSignedIn();
  view();
  await screen.findByRole("button", { name: /log out of twitch/i });
  expect(screen.queryByRole("button", { name: /^sign in to twitch$/i }))
    .not.toBeInTheDocument();
  expect(screen.queryByLabelText("Twitch username")).not.toBeInTheDocument();
});

test("names the signed-in Twitch account", async () => {
  // Otherwise the page says a session exists but not whose -- and knowing
  // which account is stored is the usual reason to be on this page at all.
  stubSignedIn();
  view();
  expect(await screen.findByTestId("signed-in-as")).toHaveTextContent("alex");
});
