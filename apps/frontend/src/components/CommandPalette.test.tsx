import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ScreenKey } from "../app.js";
import { renderLive } from "../test-utils.js";
import { CommandPalette, palette } from "./CommandPalette.js";

const snapshot = {
  lastUpdated: Date.now(), stale: false, error: null,
  streamers: [
    { username: "alpha", displayName: "Alpha", points: 1, isOnline: true, viewers: 120,
      channelId: "1", pointsEnabled: true, gained24h: 0, gainedSince: null,
      gainedStream: null, spark: [] },
    { username: "beta", displayName: "Beta", points: 1, isOnline: false,
      channelId: "2", pointsEnabled: true, gained24h: 0, gainedSince: null,
      gainedStream: null, spark: [] },
  ],
};

const campaigns = {
  campaigns: [{
    id: "c1", name: "Winter Event",
    game: { id: "g1", slug: "rust", displayName: "Rust" },
    startsAt: 1, endsAt: Date.now() + 86_400_000, status: "untouched", complete: false,
    drops: [],
  }],
  catalogueFetchedAt: Date.now(), catalogueStale: false, catalogueAvailable: true,
  catalogueError: null, progressFetchedAt: Date.now(), progressAvailable: true,
};

let calls: Array<{ url: string; init?: RequestInit }>;
let minerFails = false;

beforeEach(() => {
  calls = [];
  minerFails = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("/api/miner/") && minerFails) {
      return { ok: false, status: 500, json: async () => ({ error: "supervisor busy" }) };
    }
    if (url.startsWith("/api/miner/")) {
      return { ok: true, status: 200, json: async () => ({ state: "STOPPED", startedAt: null }) };
    }
    if (url === "/api/campaigns") return { ok: true, status: 200, json: async () => campaigns };
    return { ok: true, status: 200, json: async () => snapshot };
  }));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
});

afterEach(() => {
  // The palette's store is module-level: an open palette would leak into
  // the next test.
  act(() => palette.close());
  vi.unstubAllGlobals();
});

const screens = [
  { key: "dashboard" as ScreenKey, label: "Dashboard" },
  { key: "logs" as ScreenKey, label: "Logs" },
];

function view(minerState: string | null = "RUNNING") {
  const props = {
    screens,
    minerState,
    onMinerChange: vi.fn(),
    onNavigate: vi.fn(),
    onOpenStreamer: vi.fn(),
  };
  renderLive(<CommandPalette {...props} />);
  return props;
}

async function openAndType(text: string) {
  act(() => palette.open());
  const search = await screen.findByPlaceholderText(/search streamers/i);
  // Wait for the live snapshot, which the streamer results are built from.
  await waitFor(() => expect(calls.some((c) => c.url === "/api/streamers")).toBe(true));
  if (text !== "") await userEvent.type(search, text);
  return search;
}

test("with nothing typed it offers screens, live channels and actions", async () => {
  view();
  await openAndType("");
  expect(await screen.findByTestId("palette-streamer:alpha")).toBeInTheDocument();
  expect(screen.queryByTestId("palette-streamer:beta")).toBeNull();
  expect(screen.getByTestId("palette-screen:logs")).toBeInTheDocument();
  expect(screen.getByTestId("palette-miner:stop")).toBeInTheDocument();
});

test("choosing a streamer opens its dialog and closes the palette", async () => {
  const props = view();
  await openAndType("beta");
  await userEvent.click(await screen.findByTestId("palette-streamer:beta"));
  expect(props.onOpenStreamer).toHaveBeenCalledWith("beta");
  await waitFor(() =>
    expect(screen.queryByPlaceholderText(/search streamers/i)).toBeNull());
});

test("choosing a screen navigates there", async () => {
  const props = view();
  await openAndType("logs");
  await userEvent.click(await screen.findByTestId("palette-screen:logs"));
  expect(props.onNavigate).toHaveBeenCalledWith("logs");
});

test("campaigns are fetched on first open, once, and jump to Drops", async () => {
  const props = view();
  await openAndType("winter");
  await userEvent.click(await screen.findByTestId("palette-campaign:c1"));
  expect(props.onNavigate).toHaveBeenCalledWith("drops", { campaign: "c1" });

  await openAndType("");
  expect(calls.filter((c) => c.url === "/api/campaigns")).toHaveLength(1);
});

test("adding an untracked name goes to Streamers with it prefilled", async () => {
  const props = view();
  await openAndType("newbie");
  await userEvent.click(await screen.findByTestId("palette-add:newbie"));
  expect(props.onNavigate).toHaveBeenCalledWith("streamers", { prefill: "newbie" });
});

test("stopping asks first and does nothing until confirmed", async () => {
  const props = view();
  await openAndType("stop");
  await userEvent.click(await screen.findByTestId("palette-miner:stop"));
  expect(await screen.findByTestId("palette-confirm-text"))
    .toHaveTextContent("Stop the miner?");
  expect(calls.some((c) => c.url === "/api/miner/stop")).toBe(false);

  await userEvent.click(screen.getByTestId("palette-confirm"));
  await waitFor(() => expect(props.onMinerChange)
    .toHaveBeenCalledWith({ state: "STOPPED", startedAt: null }));
  expect(calls.find((c) => c.url === "/api/miner/stop")?.init?.method).toBe("POST");
});

test("Escape backs out of a confirmation without closing the palette", async () => {
  view();
  await openAndType("restart");
  await userEvent.click(await screen.findByTestId("palette-miner:restart"));
  await screen.findByTestId("palette-confirm-text");
  await userEvent.keyboard("{Escape}");
  expect(await screen.findByTestId("palette-miner:restart")).toBeInTheDocument();
  expect(screen.queryByTestId("palette-confirm-text")).toBeNull();
});

test("Cancel backs out too", async () => {
  view();
  await openAndType("stop");
  await userEvent.click(await screen.findByTestId("palette-miner:stop"));
  await userEvent.click(await screen.findByTestId("palette-cancel"));
  expect(await screen.findByTestId("palette-miner:stop")).toBeInTheDocument();
});

test("a failed action says why and stays open", async () => {
  minerFails = true;
  view();
  await openAndType("stop");
  await userEvent.click(await screen.findByTestId("palette-miner:stop"));
  await userEvent.click(await screen.findByTestId("palette-confirm"));
  expect(await screen.findByTestId("palette-error")).toHaveTextContent("supervisor busy");
  expect(screen.getByPlaceholderText(/search streamers/i)).toBeInTheDocument();
});

test("starting needs no confirmation", async () => {
  const props = view("STOPPED");
  await openAndType("start");
  await userEvent.click(await screen.findByTestId("palette-miner:start"));
  await waitFor(() => expect(props.onMinerChange).toHaveBeenCalled());
  expect(calls.some((c) => c.url === "/api/miner/start")).toBe(true);
});
