import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderLive } from "../test-utils.js";
import { AppLogView } from "./AppLogView.js";

/** Stands in for the shared stream, so a test can push app-log frames. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  handlers = new Map<string, (frame: { data: string }) => void>();
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (frame: { data: string }) => void) {
    this.handlers.set(type, fn);
  }
  close() {}
  push(events: unknown[], total: number) {
    act(() => {
      this.handlers.get("app-log")?.({ data: JSON.stringify({ events, total }) });
    });
  }
}

const event = (over: Record<string, unknown> = {}) => ({
  time: Date.UTC(2026, 0, 1, 12, 0, 0),
  level: "info",
  component: "drops",
  type: "subscription.pool.kept",
  msg: "pool kept",
  ...over,
});

function stub(body: unknown, ok = true) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url !== "/api/app-log") {
      return { ok: true, status: 200, json: async () => ({ streamers: [] }) };
    }
    return { ok, status: ok ? 200 : 500, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("renders an event with its type, message and evidence", async () => {
  stub({ events: [event({ liveCount: 2 })], total: 1, enabled: true });
  renderLive(<AppLogView />);
  expect(await screen.findByText("subscription.pool.kept")).toBeInTheDocument();
  expect(screen.getByText("pool kept")).toBeInTheDocument();
  // The evidence is what makes the decision checkable rather than a claim.
  expect(screen.getByText(/liveCount=2/)).toBeInTheDocument();
});

test("appends pushed events instead of re-downloading", async () => {
  stub({ events: [event()], total: 1, enabled: true });
  renderLive(<AppLogView />);
  await screen.findByText("subscription.pool.kept");
  FakeEventSource.last?.push([event({ type: "restart.proposed", msg: "restart" })], 2);
  expect(await screen.findByText("restart.proposed")).toBeInTheDocument();
});

test("a gap in pushed events triggers a reload", async () => {
  // Same contract as the miner log: only a reload can close a gap.
  let calls = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url !== "/api/app-log") {
      return { ok: true, status: 200, json: async () => ({ streamers: [] }) };
    }
    calls += 1;
    return {
      ok: true, status: 200,
      json: async () => ({ events: [event()], total: calls === 1 ? 1 : 9 }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  renderLive(<AppLogView />);
  await screen.findByText("subscription.pool.kept");
  expect(calls).toBe(1);
  // Claims 5 exist but carries 1: events 2..4 were missed.
  FakeEventSource.last?.push([event({ type: "b.thing" })], 5);
  await vi.waitFor(() => expect(calls).toBe(2));
});

test("filters by minimum level", async () => {
  stub({
    events: [event(), event({ level: "warn", type: "subscription.degraded" })],
    total: 2, enabled: true,
  });
  renderLive(<AppLogView />);
  await screen.findByText("subscription.pool.kept");
  await userEvent.click(screen.getByRole("radio", { name: "Warn+" }));
  expect(screen.queryByText("subscription.pool.kept")).not.toBeInTheDocument();
  expect(screen.getByText("subscription.degraded")).toBeInTheDocument();
});

test("filters by free text across fields", async () => {
  stub({
    events: [event({ label: "Rust drops" }), event({ type: "miner.state" })],
    total: 2, enabled: true,
  });
  renderLive(<AppLogView />);
  await screen.findByText("subscription.pool.kept");
  await userEvent.type(screen.getByLabelText("Filter events"), "rust");
  expect(screen.queryByText("miner.state")).not.toBeInTheDocument();
  expect(screen.getByText("subscription.pool.kept")).toBeInTheDocument();
});

test("says so when logging is switched off", async () => {
  // A disabled log is a configuration, not a failure; a blank panel would
  // read as something being broken.
  stub({ events: [], total: 0, enabled: false });
  renderLive(<AppLogView />);
  expect(await screen.findByText(/logging is switched off/i)).toBeInTheDocument();
});

test("an enabled but quiet log says it is waiting, not that it is off", async () => {
  stub({ events: [], total: 0, enabled: true });
  renderLive(<AppLogView />);
  expect(await screen.findByText(/No app events yet/i)).toBeInTheDocument();
  expect(screen.queryByText(/switched off/i)).not.toBeInTheDocument();
});

test("surfaces a failed load rather than showing an empty panel", async () => {
  stub({ error: "nope" }, false);
  renderLive(<AppLogView />);
  expect(await screen.findByRole("alert")).toHaveTextContent(/Failed to load app events/);
});
