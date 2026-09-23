import { screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderLive } from "../test-utils.js";
import { StreamerDetailHost } from "./StreamerDetailHost.js";

const snapshot = {
  lastUpdated: Date.now(), stale: false, error: null,
  streamers: [
    { username: "beta", displayName: "Beta", points: 20, isOnline: false,
      channelId: "2", pointsEnabled: true,
      gained24h: 0, gainedSince: null, gainedStream: null, spark: [20, 20, 20] },
  ],
};

const empty = {
  series: [], events: [], sessions: [],
  coverage: { live: [], mined: [] }, firstSeen: null, retentionFloor: null,
  gained: null, gainedSince: null,
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.startsWith("/api/history") ? empty : snapshot),
  })));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
});
afterEach(() => vi.unstubAllGlobals());

test("shows the dialog for the login it is given", async () => {
  // The dialog is behind React.lazy; warming the import keeps this test
  // waiting on the render rather than on module resolution.
  await import("./StreamerDetailModal.js");
  renderLive(<StreamerDetailHost login="beta" onClose={() => {}} />);
  expect(await screen.findByTestId("detail-title")).toHaveTextContent("Beta");
  expect(await screen.findByTestId("streams-empty")).toBeInTheDocument();
});

test("renders nothing until a login is given", async () => {
  renderLive(<StreamerDetailHost login={null} onClose={() => {}} />);
  // Let the live snapshot land, so an empty screen is not just a slow one.
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  expect(screen.queryByTestId("detail-title")).toBeNull();
});
