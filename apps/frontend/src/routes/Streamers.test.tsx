import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Streamers } from "./Streamers.js";
import { renderApp } from "../test-utils.js";

const config = {
  version: 1, username: "alex", followers: true, followersOrder: "ASC",
  defaults: {},
  streamers: [
    { username: "alpha", enabled: true, settings: {} },
    { username: "beta", enabled: true, settings: {} },
  ],
};

let calls: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("/api/streamers/lookup")) {
      const q = new URL(url, "http://x").searchParams.get("q");
      return { ok: true, status: 200,
               json: async () => ({ username: q, channelId: "1", exists: q !== "ghost" }) };
    }
    if (url === "/api/config" && (!init || init.method === "GET")) {
      return { ok: true, status: 200, json: async () => config };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const view = () => renderApp(<Streamers />);

test("lists configured streamers in priority order", async () => {
  view();
  const rows = await screen.findAllByTestId("streamer-row");
  expect(rows.map((r) => r.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining("alpha")]),
  );
  expect(rows[0].textContent).toContain("alpha");
  expect(rows[1].textContent).toContain("beta");
});

test("no apply bar until something changes", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  expect(screen.queryByTestId("pending-bar")).not.toBeInTheDocument();
});

test("toggling a streamer stages a change without restarting", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.click(screen.getAllByRole("switch")[0]);
  expect(await screen.findByTestId("pending-bar")).toHaveTextContent("1 pending change");
  expect(calls.some((c) => c.url === "/api/config/apply")).toBe(false);
});

test("apply sends the config then triggers the restart", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.click(screen.getAllByRole("switch")[0]);
  await userEvent.click(await screen.findByRole("button", { name: /apply & restart/i }));
  await waitFor(() => {
    expect(calls.some((c) => c.url === "/api/config" && c.init?.method === "PUT")).toBe(true);
    expect(calls.some((c) => c.url === "/api/config/apply")).toBe(true);
  });
});

test("adding a streamer validates the username against Twitch first", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.type(screen.getByLabelText(/add streamer/i), "gamma");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  await waitFor(() =>
    expect(calls.some((c) => c.url.includes("lookup?q=gamma"))).toBe(true),
  );
  expect(await screen.findByText("gamma")).toBeInTheDocument();
});

test("rejects a username Twitch does not know", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.type(screen.getByLabelText(/add streamer/i), "ghost");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/no such twitch user/i);
});

test("rejects adding a duplicate", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.type(screen.getByLabelText(/add streamer/i), "alpha");
  await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/already/i);
});

test("moving a streamer up reorders priority and stages a change", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.click(screen.getAllByRole("button", { name: /move up/i })[1]);
  const rows = screen.getAllByTestId("streamer-row");
  expect(rows[0].textContent).toContain("beta");
  expect(await screen.findByTestId("pending-bar")).toBeInTheDocument();
});

// --- Correction 1: the add-streamer path must not swallow errors ---

test("surfaces an error when the username lookup rejects, and leaves the form usable", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("/api/streamers/lookup")) {
      // Mirrors the backend: usernameSchema rejects a too-short query with a 400.
      return {
        ok: false, status: 400,
        json: async () => ({ error: "not a valid Twitch username" }),
      };
    }
    if (url === "/api/config" && (!init || init.method === "GET")) {
      return { ok: true, status: 200, json: async () => config };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));

  view();
  await screen.findAllByTestId("streamer-row");
  const input = screen.getByLabelText(/add streamer/i);
  await userEvent.type(input, "bad");
  const addButton = screen.getByRole("button", { name: /^add$/i });
  await userEvent.click(addButton);

  expect(await screen.findByRole("alert")).toHaveTextContent(/not a valid twitch username/i);
  // The form must not be wedged: no extra row was added, and the control
  // is still usable for another attempt.
  expect(screen.getAllByTestId("streamer-row")).toHaveLength(2);
  expect(addButton).toBeEnabled();
  expect(input).toBeEnabled();
  await userEvent.clear(input);
  await userEvent.type(input, "gamma");
  expect(input).toHaveValue("gamma");
});

test("shows an error when the initial config fails to load, instead of a blank screen", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/config" && (!init || init.method === "GET")) {
      return { ok: false, status: 500, json: async () => ({ error: "disk on fire" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));

  const { container } = view();
  expect(await screen.findByRole("alert")).toHaveTextContent(/disk on fire/i);
  expect(screen.queryByTestId("streamer-row")).not.toBeInTheDocument();
  expect(container.textContent).not.toBe("");
});

test("marks the top two rows as the ones actually being watched", async () => {
  // The miner watches the top two. That was a sentence the user had to
  // remember; it should be visible on the rows it applies to.
  // Its own stub rather than mutating the shared `config`, which would
  // leak into whichever test ran next.
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({
      ...config,
      streamers: [
        { username: "aaa", enabled: true, settings: {} },
        { username: "bbb", enabled: true, settings: {} },
        { username: "ccc", enabled: true, settings: {} },
      ],
    }),
  })));
  view();
  expect(await screen.findAllByTestId("watching-tag")).toHaveLength(2);
});
