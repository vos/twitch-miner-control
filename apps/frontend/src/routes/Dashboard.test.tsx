import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CLIENT_STALE_AFTER_MS } from "../components/StalenessBadge.js";
import { Dashboard } from "./Dashboard.js";
import { renderApp } from "../test-utils.js";

const snapshot = {
  lastUpdated: Date.now(),
  stale: false,
  error: null,
  streamers: [
    { username: "alpha", displayName: "Alpha", points: 123456, isOnline: true,
      channelId: "1", pointsEnabled: true,
      gained24h: 500, gainedSince: null, gainedStream: 120,
      spark: [122000, 123000, 123456] },
    { username: "beta", displayName: "Beta", points: 20, isOnline: false,
      channelId: "2", pointsEnabled: true,
      gained24h: 0, gainedSince: null, gainedStream: null, spark: [20, 20, 20] },
  ],
};

function stub(body: unknown) {
  const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
  return fetchMock;
}

beforeEach(() => stub(snapshot));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // The dashboard's toggles persist to localStorage, which jsdom shares
  // across tests in this file. Without this, collapsing a section in one
  // test silently changes what the next one renders.
  localStorage.clear();
});

const view = () => renderApp(<Dashboard />);

test("shows who is live", async () => {
  view();
  expect(await screen.findByTestId("streamer-alpha")).toBeInTheDocument();
  expect(screen.getByTestId("live-heading")).toHaveTextContent("LIVE NOW · 1");
});

test("shows gains on the card so the balance has a reference point", async () => {
  view();
  expect(await screen.findByTestId("streamer-alpha")).toHaveTextContent("+120");
  expect(screen.getByTestId("streamer-alpha")).toHaveTextContent("+500");
});

test("shows exact point totals, not abbreviated ones", async () => {
  view();
  expect(await screen.findByText("123,456")).toBeInTheDocument();
});

test("shows a total across streamers", async () => {
  view();
  expect(await screen.findByTestId("total-points")).toHaveTextContent("123,476");
});

test("marks the view stale rather than presenting old numbers as current", async () => {
  stub({ ...snapshot, stale: true, lastUpdated: Date.now() - 300_000 });
  view();
  expect(await screen.findByTestId("staleness")).toHaveTextContent(/stale/i);
});

test("surfaces a refresh error without hiding the last known numbers", async () => {
  stub({ ...snapshot, stale: true, error: "gql exploded" });
  view();
  expect(await screen.findByRole("alert")).toHaveTextContent("gql exploded");
  expect(screen.getByText("123,456")).toBeInTheDocument();
});

// I5: the backend now kicks a refresh at boot instead of only arming its
// 60s interval, but the very first render (before that refresh's response
// has come back) still has lastUpdated: null -- and rendering "0" there is
// indistinguishable from a real, checked total of zero. This must fail
// against code that renders nf.format(total) unconditionally.
test("shows a placeholder total, not a fabricated zero, before any refresh has completed", async () => {
  stub({ ...snapshot, lastUpdated: null, streamers: [] });
  view();
  expect(await screen.findByTestId("total-points")).toHaveTextContent("—");
});

test("renders a streamer whose points could not be read as unknown, not zero", async () => {
  stub({ ...snapshot, streamers: [
    { username: "ghost", displayName: null, points: null, isOnline: null,
      channelId: null, pointsEnabled: null,
      gained24h: null, gainedSince: null, gainedStream: null, spark: [] },
  ] });
  view();
  // Scoped to the card's own balance: the 24h-gain tile legitimately
  // shows the same placeholder, so a bare text query is ambiguous.
  expect(await screen.findByTestId("balance")).toHaveTextContent("—");
});

test("flags the 24h tile as partial when a streamer has less than a day of history", async () => {
  stub({ ...snapshot, streamers: [
    { ...snapshot.streamers[0], gained24h: 500, gainedSince: null },
    { ...snapshot.streamers[1], gained24h: 60, gainedSince: Date.now() - 2 * 3_600_000 },
  ] });
  view();
  const tile = await screen.findByTestId("stat-24h");
  // The gain is still summed and shown -- the caveat qualifies it, it does
  // not replace it with a dash.
  expect(tile).toHaveTextContent("+560");
  expect(tile).toHaveTextContent(/partial/i);
});

test("does not flag the 24h tile when every streamer has a full window", async () => {
  view();
  const tile = await screen.findByTestId("stat-24h");
  expect(tile).toHaveTextContent("+500");
  expect(tile).not.toHaveTextContent(/partial/i);
});

// Correction 3: a failed initial load must not leave a blank dashboard
// with no explanation (the same silent-swallow pattern fixed in
// Streamers.tsx). This must surface via a role="alert", following that
// file's established shape.
test("surfaces an error instead of a blank dashboard when the initial load fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false, status: 500, json: async () => ({ error: "backend unreachable" }),
  })));
  vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
  view();
  expect(await screen.findByRole("alert")).toHaveTextContent("backend unreachable");
});

// Correction 1: the server's `stale` flag only reaches the browser when a
// frame arrives. If the SSE connection dies (or the backend stops
// refreshing) after a healthy snapshot, the last snapshot the browser
// holds keeps `stale: false` forever -- the badge must not trust that
// flag alone. This test cannot pass against the brief's original code,
// which renders `stale` verbatim and never re-evaluates on a clock tick.
test("goes stale locally when no further frames arrive, even though the server said fresh", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  stub({ ...snapshot, stale: false, lastUpdated: now });

  renderApp(<Dashboard />);

  // Let the initial REST fetch resolve and the first paint happen.
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByTestId("staleness")).not.toHaveTextContent(/stale/i);

  // No SSE frame ever arrives (the fake EventSource never emits). Advance
  // the clock past the client-side staleness threshold and let the
  // ticking clock inside the badge re-render.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CLIENT_STALE_AFTER_MS + 5_000);
  });

  expect(screen.getByTestId("staleness")).toHaveTextContent(/stale/i);
});

test("switching the activity feed off stops its polling", async () => {
  // The dashboard owns the toggle; EventsFeed owns the effect. This
  // asserts the wiring between them actually reaches the network.
  const fetchMock = stub(snapshot);
  view();

  await userEvent.click(await screen.findByRole("switch", { name: /activity feed/i }));

  fetchMock.mockClear();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/events")).toBe(false);
});

test("shows the tracked-streamer count as a stat", async () => {
  view();
  expect(await screen.findByTestId("stat-tracked")).toHaveTextContent("2");
});

// A roster of mostly-offline streamers pushes the live cards -- the only
// ones with anything happening -- off the top of the screen. Collapsing
// the offline section must leave its count behind, so "hidden" never
// reads as "none tracked".
test("collapses the offline streamers to just a count", async () => {
  view();
  expect(await screen.findByTestId("streamer-beta")).toBeInTheDocument();

  await userEvent.click(screen.getByTestId("offline-heading"));

  expect(screen.queryByTestId("streamer-beta")).not.toBeInTheDocument();
  expect(screen.getByTestId("offline-heading")).toHaveTextContent("OFFLINE · 1");
  // Live cards are unaffected -- this hides one section, not the roster.
  expect(screen.getByTestId("streamer-alpha")).toBeInTheDocument();
});

test("remembers the offline section stays collapsed across a remount", async () => {
  const first = view();
  await userEvent.click(await screen.findByTestId("offline-heading"));
  first.unmount();

  view();
  expect(await screen.findByTestId("streamer-alpha")).toBeInTheDocument();
  expect(screen.queryByTestId("streamer-beta")).not.toBeInTheDocument();
});
