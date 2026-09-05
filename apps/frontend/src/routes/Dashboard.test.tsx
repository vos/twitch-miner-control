import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CLIENT_STALE_AFTER_MS } from "../components/StalenessBadge.js";
import { Dashboard } from "./Dashboard.js";

const snapshot = {
  lastUpdated: Date.now(),
  stale: false,
  error: null,
  streamers: [
    { username: "alpha", displayName: "Alpha", points: 123456, isOnline: true,
      channelId: "1", pointsEnabled: true,
      gained24h: 500, gainedStream: 120, spark: [122000, 123000, 123456] },
    { username: "beta", displayName: "Beta", points: 20, isOnline: false,
      channelId: "2", pointsEnabled: true,
      gained24h: 0, gainedStream: null, spark: [20, 20, 20] },
  ],
};

function stub(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
}

beforeEach(() => stub(snapshot));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const view = () => render(<MantineProvider><Dashboard /></MantineProvider>);

test("shows who is live", async () => {
  view();
  expect(await screen.findByTestId("streamer-alpha")).toBeInTheDocument();
  expect(screen.getByTestId("live-heading")).toHaveTextContent("Live now (1)");
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
      gained24h: null, gainedStream: null, spark: [] },
  ] });
  view();
  expect(await screen.findByText("—")).toBeInTheDocument();
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

  render(<MantineProvider><Dashboard /></MantineProvider>);

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
