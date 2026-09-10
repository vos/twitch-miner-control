import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Streamers } from "./Streamers.js";
import { renderApp, restoreRects, stubRowRects } from "../test-utils.js";

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
    // After the lookup branch above, which matches with startsWith --
    // an exact-match branch placed first would swallow lookup calls.
    if (url === "/api/streamers") {
      return { ok: true, status: 200, json: async () => ({
        streamers: [
          { username: "alpha", avatarUrl: "https://cdn/a.png",
            isOnline: true, liveSince: Date.now() - 2 * 60 * 60 * 1000, lastLive: null,
            watching: true },
          { username: "beta", avatarUrl: null,
            isOnline: false, liveSince: null,
            lastLive: Date.now() - 3 * 24 * 60 * 60 * 1000,
            watching: false },
        ],
      }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }));
});
afterEach(() => { vi.unstubAllGlobals(); restoreRects(); });

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

/**
 * Drives one pointer drag from `handle` by `dy` pixels.
 *
 * dnd-kit's PointerSensor only begins a drag once the pointer has travelled
 * past its activation distance, so the move is sent in two steps: one to get
 * over the threshold and one to land on the target row.
 */
async function dragBy(handle: HTMLElement, dy: number) {
  const user = userEvent.setup();
  await user.pointer([
    { keys: "[MouseLeft>]", target: handle, coords: { x: 10, y: 10 } },
    { target: handle, coords: { x: 10, y: 10 + Math.sign(dy) * 20 } },
    { target: handle, coords: { x: 10, y: 10 + dy } },
    { keys: "[/MouseLeft]", target: handle, coords: { x: 10, y: 10 + dy } },
  ]);
}

test("dragging a streamer down reorders priority and stages a change", async () => {
  stubRowRects();
  view();
  await screen.findAllByTestId("streamer-row");

  // alpha is first; drag it one row (50px) down past beta's midpoint.
  const handles = screen.getAllByRole("button", { name: /reorder/i });
  await dragBy(handles[0], 60);

  const rows = screen.getAllByTestId("streamer-row");
  expect(rows[0].textContent).toContain("beta");
  expect(rows[1].textContent).toContain("alpha");
  expect(await screen.findByTestId("pending-bar")).toBeInTheDocument();
});

test("the drag handle reorders from the keyboard alone", async () => {
  stubRowRects();
  view();
  await screen.findAllByTestId("streamer-row");

  // Space lifts, arrow moves, space drops -- the path a keyboard user takes
  // now that the move-up arrow is gone.
  screen.getAllByRole("button", { name: /reorder/i })[0].focus();
  await userEvent.keyboard("{ }");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{ }");

  const rows = screen.getAllByTestId("streamer-row");
  expect(rows[0].textContent).toContain("beta");
  expect(rows[1].textContent).toContain("alpha");
});

test("a drag cancelled mid-flight leaves the order alone", async () => {
  stubRowRects();
  view();
  await screen.findAllByTestId("streamer-row");

  screen.getAllByRole("button", { name: /reorder/i })[0].focus();
  await userEvent.keyboard("{ }");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{Escape}");

  const rows = screen.getAllByTestId("streamer-row");
  expect(rows[0].textContent).toContain("alpha");
  expect(rows[1].textContent).toContain("beta");
  expect(screen.queryByTestId("pending-bar")).not.toBeInTheDocument();
});

test("the watching tag stays with its streamer when the order changes", async () => {
  // The tag reports what the miner is mining, which a drag does not
  // change: reordering is a staged edit that has not reached the miner
  // yet, so the tag has to follow the streamer, not the position.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/config") {
      return { ok: true, status: 200, json: async () => ({
        ...config,
        streamers: [
          { username: "aaa", enabled: true, settings: {} },
          { username: "bbb", enabled: true, settings: {} },
          { username: "ccc", enabled: true, settings: {} },
        ],
      }) };
    }
    if (url === "/api/streamers") {
      return { ok: true, status: 200, json: async () => ({
        streamers: [
          { username: "aaa", avatarUrl: null, isOnline: true,
            liveSince: null, lastLive: null, watching: false },
          { username: "bbb", avatarUrl: null, isOnline: true,
            liveSince: null, lastLive: null, watching: false },
          { username: "ccc", avatarUrl: null, isOnline: true,
            liveSince: null, lastLive: null, watching: true },
        ],
      }) };
    }
    throw new Error("unexpected request");
  }));
  stubRowRects();
  view();
  await waitFor(() =>
    expect(screen.getAllByTestId("watching-tag")).toHaveLength(1),
  );

  // Drag ccc (last) to the top: two rows up, 100px.
  await dragBy(screen.getAllByRole("button", { name: /reorder/i })[2], -100);

  const rows = screen.getAllByTestId("streamer-row");
  expect(rows[0].textContent).toContain("ccc");
  expect(rows[0].textContent).toContain("watching");
  expect(rows[1].textContent).not.toContain("watching");
  expect(rows[2].textContent).not.toContain("watching");
});

test("no watching tag for a streamer the miner is not mining", async () => {
  // The top of the list is not evidence of anything: an offline or
  // points-disabled channel keeps its priority and earns no tag.
  view();
  await screen.findAllByTestId("streamer-row");
  await waitFor(() =>
    expect(screen.getAllByTestId("watching-tag")).toHaveLength(1),
  );
  const rows = screen.getAllByTestId("streamer-row");
  expect(rows[0].textContent).toContain("alpha");
  expect(rows[0].textContent).toContain("watching");
  // beta is second in priority but offline, so nothing is claimed for it.
  expect(rows[1].textContent).not.toContain("watching");
});

test("no watching tags at all when the live state is unreachable", async () => {
  // The config screen is used with the miner stopped, which is exactly
  // when a position-derived tag used to invent two watched streamers.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/config") {
      return { ok: true, status: 200, json: async () => config };
    }
    throw new Error("no live state");
  }));
  view();
  await screen.findAllByTestId("streamer-row");
  expect(screen.queryAllByTestId("watching-tag")).toHaveLength(0);
});

test("adding by pasted channel link looks up and stores the bare username", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  await userEvent.type(
    screen.getByLabelText(/add streamer/i),
    "https://www.twitch.tv/gamma{Enter}",
  );

  // The URL never reaches the server: the lookup route only accepts a login.
  await waitFor(() => {
    expect(calls.some((c) => c.url === "/api/streamers/lookup?q=gamma")).toBe(true);
  });
  const rows = await screen.findAllByTestId("streamer-row");
  expect(rows).toHaveLength(3);
  expect(rows[2].textContent).toContain("gamma");
});

// --- Correction 1: the add-streamer path must not swallow errors ---

test("surfaces an error when the username lookup rejects, and leaves the form usable", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("/api/streamers/lookup")) {
      // Mirrors the backend rejecting the lookup. The value below is
      // username-shaped -- the field's own parser has to let it through --
      // so what is under test is the server error path, not client parsing.
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
  await userEvent.type(input, "badname");
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

test("tags whichever rows the miner reports it is watching", async () => {
  // Which channels hold the two watch slots is the miner's decision, not
  // the list's -- so the tags have to come from the live snapshot and can
  // land on any rows at all.
  // Its own stub rather than mutating the shared `config`, which would
  // leak into whichever test ran next.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/streamers") {
      return { ok: true, status: 200, json: async () => ({
        streamers: [
          { username: "aaa", avatarUrl: null, isOnline: true,
            liveSince: null, lastLive: null, watching: true },
          { username: "bbb", avatarUrl: null, isOnline: true,
            liveSince: null, lastLive: null, watching: false },
          { username: "ccc", avatarUrl: null, isOnline: true,
            liveSince: null, lastLive: null, watching: true },
        ],
      }) };
    }
    return {
      ok: true, status: 200,
      json: async () => ({
        ...config,
        streamers: [
          { username: "aaa", enabled: true, settings: {} },
          { username: "bbb", enabled: true, settings: {} },
          { username: "ccc", enabled: true, settings: {} },
        ],
      }),
    };
  }));
  view();
  // Two tags because the miner reports two watched channels -- and they are
  // rows 1 and 3, which no position rule would have produced.
  expect(await screen.findAllByTestId("watching-tag")).toHaveLength(2);
  const rows = screen.getAllByTestId("streamer-row");
  expect(rows[0].textContent).toContain("watching");
  expect(rows[1].textContent).not.toContain("watching");
  expect(rows[2].textContent).toContain("watching");
});

test("shows an avatar and a channel link per configured streamer", async () => {
  const { container } = view();
  const link = await screen.findByRole("link", { name: /alpha on Twitch/i });
  expect(link).toHaveAttribute("href", "https://twitch.tv/alpha");
  await waitFor(() => {
    expect(container.querySelector("img")).toHaveAttribute("src", "https://cdn/a.png");
  });
});

test("stays usable when the live state cannot be loaded", async () => {
  // The miner being stopped must cost the config screen its pictures and
  // nothing else -- this is the screen you use to fix a broken setup.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/config") {
      return { ok: true, status: 200, json: async () => config };
    }
    throw new Error("miner is stopped");
  }));
  view();
  expect(await screen.findByText("alpha")).toBeInTheDocument();
  expect(screen.getAllByTestId("streamer-row").length).toBe(2);
});


// --- live status on the config rows ---

test("shows each streamer's live state so the order can be judged", async () => {
  view();
  await screen.findAllByTestId("streamer-row");

  // alpha is live, beta went offline three days ago. Both facts drive the
  // decision this screen exists for: who is worth a watch slot -- and an
  // offline channel cannot take one at all.
  expect(await screen.findByTestId("live-pill")).toHaveTextContent("LIVE 2h");
  expect(screen.getByTestId("offline-pill")).toHaveTextContent("OFFLINE 3d");
});

test("shows no status at all when the miner cannot be reached", async () => {
  // The config screen has to work with the miner stopped. An OFFLINE pill
  // here would assert something we did not observe.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/config") {
      return { ok: true, status: 200, json: async () => config };
    }
    throw new Error("miner is stopped");
  }));
  view();
  await screen.findAllByTestId("streamer-row");
  expect(screen.queryByTestId("live-pill")).not.toBeInTheDocument();
  expect(screen.queryByTestId("offline-pill")).not.toBeInTheDocument();
});

test("the refresh button re-reads the live state", async () => {
  view();
  await screen.findAllByTestId("streamer-row");
  const before = calls.filter((c) => c.url === "/api/streamers").length;

  await userEvent.click(screen.getByRole("button", { name: /refresh/i }));

  await waitFor(() => {
    expect(calls.filter((c) => c.url === "/api/streamers").length).toBe(before + 1);
  });
});

test("refreshing keeps a staged reorder instead of discarding it", async () => {
  // The draft is the user's unsaved work. Refreshing pulls status only --
  // clobbering the order they just arranged would be the worst possible
  // moment to lose it.
  stubRowRects();
  view();
  await screen.findAllByTestId("streamer-row");
  await dragBy(screen.getAllByRole("button", { name: /reorder/i })[0], 60);
  expect(screen.getAllByTestId("streamer-row")[0].textContent).toContain("beta");

  await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
  await waitFor(() => {
    expect(screen.getAllByTestId("streamer-row")[0].textContent).toContain("beta");
  });
  expect(await screen.findByTestId("pending-bar")).toBeInTheDocument();
});

test("removing a streamer drops the row and stages one change", async () => {
  view();
  await screen.findAllByTestId("streamer-row");

  await userEvent.click(screen.getByRole("button", { name: /remove alpha/i }));

  const rows = screen.getAllByTestId("streamer-row");
  expect(rows).toHaveLength(1);
  expect(rows[0].textContent).toContain("beta");
  expect(await screen.findByTestId("pending-bar")).toHaveTextContent("1 pending change");
  // Staged only: nothing reaches the miner until Apply & Restart.
  expect(calls.some((c) => c.url === "/api/config/apply")).toBe(false);
  expect(calls.some((c) => c.init?.method === "PUT")).toBe(false);
});

test("applying a removal sends a config without that streamer", async () => {
  view();
  await screen.findAllByTestId("streamer-row");

  await userEvent.click(screen.getByRole("button", { name: /remove alpha/i }));
  await userEvent.click(await screen.findByRole("button", { name: /apply & restart/i }));

  await waitFor(() => {
    expect(calls.some((c) => c.url === "/api/config" && c.init?.method === "PUT")).toBe(true);
  });
  const put = calls.find((c) => c.url === "/api/config" && c.init?.method === "PUT");
  const sent = JSON.parse(String(put?.init?.body)) as typeof config;
  expect(sent.streamers.map((s) => s.username)).toEqual(["beta"]);
  expect(calls.some((c) => c.url === "/api/config/apply")).toBe(true);
});

test("a staged removal does not move the watching tag", async () => {
  // Removal is staged until Apply & Restart, so the miner is still mining
  // exactly what it was. Promoting the tag on a local edit would claim a
  // slot change that has not happened.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/config") {
      return { ok: true, status: 200, json: async () => ({
        ...config,
        streamers: [
          { username: "aaa", enabled: true, settings: {} },
          { username: "bbb", enabled: true, settings: {} },
          { username: "ccc", enabled: true, settings: {} },
        ],
      }) };
    }
    if (url === "/api/streamers") {
      return { ok: true, status: 200, json: async () => ({
        streamers: [
          { username: "aaa", avatarUrl: null, isOnline: true,
            liveSince: null, lastLive: null, watching: true },
          { username: "bbb", avatarUrl: null, isOnline: false,
            liveSince: null, lastLive: null, watching: false },
          { username: "ccc", avatarUrl: null, isOnline: false,
            liveSince: null, lastLive: null, watching: false },
        ],
      }) };
    }
    throw new Error("unexpected request");
  }));
  view();
  await waitFor(() =>
    expect(screen.getAllByTestId("watching-tag")).toHaveLength(1),
  );

  await userEvent.click(screen.getByRole("button", { name: /remove aaa/i }));

  // aaa is gone from the draft, and with it the only tag: bbb does not
  // inherit a watch slot by moving up.
  const rows = screen.getAllByTestId("streamer-row");
  expect(rows[0].textContent).toContain("bbb");
  expect(screen.queryAllByTestId("watching-tag")).toHaveLength(0);
});
