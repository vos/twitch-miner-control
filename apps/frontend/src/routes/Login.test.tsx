import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { TwitchLogin } from "./Login.js";

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

const view = () => render(<MantineProvider><TwitchLogin /></MantineProvider>);

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
  const fetchMock = vi.fn(async (_url: string) => ({
    ok: true, status: 200, json: async () => ({ login: null }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  view();
  await userEvent.click(await screen.findByRole("button", { name: /sign in to twitch/i }));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/twitch/login")).toBe(true);
});
