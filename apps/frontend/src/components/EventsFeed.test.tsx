import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventsFeed } from "./EventsFeed.js";

/**
 * The feed subscribes to the same /api/stream the dashboard uses, so every
 * test needs an EventSource. jsdom has none.
 */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  static created = 0;
  handlers = new Map<string, (event: MessageEvent) => void>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.last = this;
    FakeEventSource.created += 1;
  }
  addEventListener(type: string, handler: (event: MessageEvent) => void) {
    this.handlers.set(type, handler);
  }
  close() { this.closed = true; }
  /** Delivers a pushed row exactly as the server frames it: JSON text. */
  push(row: unknown) {
    act(() => {
      this.handlers.get("event")?.({ data: JSON.stringify(row) } as MessageEvent);
    });
  }
}

function stub(body: unknown, ok = true) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok, status: ok ? 200 : 500, json: async () => body,
  })));
}

beforeEach(() => {
  FakeEventSource.last = null;
  FakeEventSource.created = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
});

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

test("fetches the backlog once and then leaves the network alone", async () => {
  // The bug this replaced: a 5s poll that re-sent all 20 rows forever.
  // New rows now arrive on the stream, so exactly one request is correct.
  const fetchMock = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ events: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  render(<MantineProvider><EventsFeed enabled /></MantineProvider>);

  await screen.findByText(/no activity yet/i);
  expect(fetchMock).toHaveBeenCalledWith("/api/events", expect.anything());

  // Well past the old 5s poll period.
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("renders a row pushed over the stream without refetching", async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ events: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  render(<MantineProvider><EventsFeed enabled /></MantineProvider>);
  await screen.findByText(/no activity yet/i);

  FakeEventSource.last!.push({
    ts: Date.now(), type: "GAIN_FOR_CLAIM", message: "+50 -> forsen",
  });

  expect(await screen.findByText("+50 -> forsen")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("puts a pushed row above the backlog and caps the list", async () => {
  stub({
    events: Array.from({ length: 20 }, (_, i) => ({
      ts: 1000 - i, type: "BONUS_CLAIM", message: `old ${i}`,
    })),
  });

  render(<MantineProvider><EventsFeed enabled /></MantineProvider>);
  await screen.findByText("old 0");

  FakeEventSource.last!.push({ ts: 2000, type: "GAIN_FOR_CLAIM", message: "brand new" });

  const rows = screen.getAllByText(/brand new|old \d+/);
  expect(rows[0]).toHaveTextContent("brand new");
  // Still 20: the oldest row falls off rather than growing without bound.
  expect(rows).toHaveLength(20);
  expect(screen.queryByText("old 19")).not.toBeInTheDocument();
});

test("ignores a malformed pushed frame", async () => {
  stub({ events: [] });
  render(<MantineProvider><EventsFeed enabled /></MantineProvider>);
  await screen.findByText(/no activity yet/i);

  act(() => {
    FakeEventSource.last!.handlers.get("event")?.({ data: "not json" } as MessageEvent);
  });

  // Survives, still rendering the panel rather than taking the page down.
  expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
});

test("closes the stream when the feed is switched off", async () => {
  stub({ events: [] });
  const { rerender } = render(<MantineProvider><EventsFeed enabled /></MantineProvider>);
  await screen.findByText(/no activity yet/i);
  const source = FakeEventSource.last!;

  rerender(<MantineProvider><EventsFeed enabled={false} /></MantineProvider>);

  // Switching off must drop the connection, not just hide the panel.
  expect(source.closed).toBe(true);
});
