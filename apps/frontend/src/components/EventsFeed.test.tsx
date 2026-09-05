import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { EventsFeed } from "./EventsFeed.js";

function stub(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok, status: ok ? 200 : 500, json: async () => body,
  })));
}

afterEach(() => vi.unstubAllGlobals());

const view = () => render(<MantineProvider><EventsFeed enabled /></MantineProvider>);

test("renders the miner's own line, which names the streamer", async () => {
  // The whole point of the panel: "streamer online" alone said nothing
  // about which channel, because the event name has no identity in it.
  stub({
    events: [
      { ts: Date.now(), type: "GAIN_FOR_CLAIM", message: "+50 -> forsen" },
    ],
  });
  view();
  expect(await screen.findByText("+50 -> forsen")).toBeInTheDocument();
});

test("falls back to the event name for a row stored without a message", async () => {
  // Rows written before the doorbell forwarded a message.
  stub({ events: [{ ts: Date.now(), type: "STREAMER_ONLINE", message: null }] });
  view();
  expect(await screen.findByText(/streamer online/i)).toBeInTheDocument();
});

test("says so when nothing has happened yet", async () => {
  stub({ events: [] });
  view();
  expect(await screen.findByText(/no activity yet/i)).toBeInTheDocument();
});

test("stays silent when the feed cannot be loaded", async () => {
  // The feed is ancillary; a failure must not put an error banner on the
  // dashboard beside perfectly good numbers.
  stub({ error: "boom" }, false);
  const { container } = view();
  await new Promise((r) => setTimeout(r, 0));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("stays silent when a 200 carries the wrong shape", async () => {
  // The dashboard stubs one fetch for every URL, so this panel can be
  // handed a payload with no `events` key. That must not crash the page.
  stub({ streamers: [], lastUpdated: 1 });
  view();
  await new Promise((r) => setTimeout(r, 0));
  // MantineProvider injects <style> tags, so assert on the feed's own
  // content rather than an empty container.
  expect(screen.queryByText(/recent activity/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/no activity yet/i)).not.toBeInTheDocument();
});

test("does not touch the network when the feed is switched off", async () => {
  // The requirement is that polling stops, not that the panel is hidden.
  // A component that renders nothing while still fetching every 5s would
  // pass a DOM-absence assertion and fail the actual ask.
  const fetchMock = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ events: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  render(<MantineProvider><EventsFeed enabled={false} /></MantineProvider>);

  // Give any mount effect a chance to fire before asserting silence.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(screen.queryByText(/recent activity/i)).not.toBeInTheDocument();
});

test("polls while the feed is switched on", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ events: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  render(<MantineProvider><EventsFeed enabled /></MantineProvider>);

  await screen.findByText(/no activity yet/i);
  expect(fetchMock).toHaveBeenCalledWith("/api/events", expect.anything());
});
