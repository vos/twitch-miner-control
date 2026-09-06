import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { LogoutButton } from "./LogoutButton.js";
import { PasswordGate } from "./PasswordGate.js";
import { SessionContext } from "./session.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok, status: ok ? 200 : 500, json: async () => ({}),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("posts to the logout route", async () => {
  const fetchMock = stubFetch();
  // Wrapped in a provider purely so the default's location.reload() does
  // not fire -- jsdom cannot navigate and logs a scary trace.
  renderApp(
    <SessionContext.Provider value={{ onLoggedOut: () => {} }}>
      <LogoutButton />
    </SessionContext.Provider>,
  );
  await userEvent.click(screen.getByTestId("logout"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    "/api/session/logout",
    expect.objectContaining({ method: "POST" }),
  ));
});

test("tells the session it ended", async () => {
  stubFetch();
  const onLoggedOut = vi.fn();
  renderApp(
    <SessionContext.Provider value={{ onLoggedOut }}>
      <LogoutButton />
    </SessionContext.Provider>,
  );
  await userEvent.click(screen.getByTestId("logout"));
  await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
});

test("locks up even when the logout call fails", async () => {
  // A failed call may leave the cookie live, so the safe move is to lock
  // and make the user prove themselves again.
  stubFetch(false);
  const onLoggedOut = vi.fn();
  renderApp(
    <SessionContext.Provider value={{ onLoggedOut }}>
      <LogoutButton />
    </SessionContext.Provider>,
  );
  await userEvent.click(screen.getByTestId("logout"));
  await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
});

test("returns the app to the password screen", async () => {
  // The whole point, end to end: the gate is showing content, and after a
  // logout it is showing the form again.
  const queue = [200, 200];
  vi.stubGlobal("fetch", vi.fn(async () => {
    const status = queue.shift() ?? 200;
    return { ok: status < 300, status, json: async () => ({}) };
  }));
  renderApp(
    <PasswordGate>
      <LogoutButton />
    </PasswordGate>,
  );
  await userEvent.click(await screen.findByTestId("logout"));
  expect(await screen.findByLabelText("Password")).toBeInTheDocument();
  expect(screen.queryByTestId("logout")).not.toBeInTheDocument();
});
