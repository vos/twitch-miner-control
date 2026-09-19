import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderLive } from "../test-utils.js";
import { Logs } from "./Logs.js";

/** Stands in for the shared stream, so a test can push log frames. */
class FakeEventSource {
  static last: FakeEventSource | null = null;
  handlers = new Map<string, (frame: { data: string }) => void>();
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (frame: { data: string }) => void) {
    this.handlers.set(type, fn);
  }
  close() {}
  /** Delivers a log frame exactly as the server writes one. */
  pushLog(lines: string[], total: number) {
    act(() => {
      this.handlers.get("log")?.({ data: JSON.stringify({ lines, total }) });
    });
  }
}

/** Answers /api/logs from `logs`, and every other request with nothing much. */
function stubLogs(logs: () => { ok: boolean; body: unknown }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url !== "/api/logs") {
      return { ok: true, status: 200, json: async () => ({ streamers: [] }) };
    }
    const { ok, body } = logs();
    return { ok, status: ok ? 200 : 500, json: async () => body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return () => fetchMock.mock.calls.filter(([url]) => url === "/api/logs").length;
}

beforeEach(() => {
  FakeEventSource.last = null;
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const view = () => renderLive(<Logs />);

test("renders log lines from the API", async () => {
  stubLogs(() => ({ ok: true, body: { lines: ["hello", "world"], total: 2 } }));
  view();
  expect(await screen.findByText(/hello/)).toBeInTheDocument();
  expect(screen.getByText(/world/)).toBeInTheDocument();
});

// Correction 1: a failing /api/logs must not render a silently empty
// panel -- indistinguishable from "the miner logged nothing" -- because
// this panel is exactly where an operator looks to diagnose a crash.
test("surfaces a visible message when the log fetch fails", async () => {
  stubLogs(() => ({ ok: false, body: { error: "disk on fire" } }));
  view();
  expect(await screen.findByRole("alert")).toHaveTextContent(/disk on fire/i);
});

test("retries a failed load, and a success clears the error", async () => {
  vi.useFakeTimers();
  let call = 0;
  stubLogs(() => {
    call += 1;
    return call === 1
      ? { ok: false, body: { error: "disk on fire" } }
      : { ok: true, body: { lines: ["recovered"], total: 1 } };
  });

  view();

  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByRole("alert")).toHaveTextContent(/disk on fire/i);

  // The banner must clear rather than persist forever.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText(/recovered/)).toBeInTheDocument();
});

test("appends pushed lines instead of re-downloading the log", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const logCalls = stubLogs(() => ({ ok: true, body: { lines: ["first", "second"], total: 2 } }));
  view();
  await screen.findByText(/second/);

  FakeEventSource.last!.pushLog(["third"], 3);
  expect(screen.getByText(/third/)).toBeInTheDocument();

  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(logCalls()).toBe(1);
});

test("skips pushed lines it already has", async () => {
  // A frame sent while the first load was in flight repeats lines that
  // load already returned.
  stubLogs(() => ({ ok: true, body: { lines: ["one", "two", "three"], total: 3 } }));
  view();
  await screen.findByText(/three/);

  FakeEventSource.last!.pushLog(["two", "three"], 3);
  FakeEventSource.last!.pushLog(["three", "four"], 4);

  expect(screen.getAllByText(/two|three|four/).map((el) => el.textContent))
    .toEqual(["two", "three", "four"]);
});

test("reloads the log when pushed lines show it missed some", async () => {
  // Frames lost while the stream was reconnecting leave a gap that
  // appending cannot close.
  let total = 2;
  const logCalls = stubLogs(() => ({
    ok: true,
    body: { lines: Array.from({ length: total }, (_, i) => `line ${i + 1}`), total },
  }));
  view();
  await screen.findByText("line 2");

  total = 5;
  FakeEventSource.last!.pushLog(["line 5"], 5);

  expect(await screen.findByText("line 3")).toBeInTheDocument();
  expect(logCalls()).toBe(2);
});

test("the app events tab is reachable and remembered", async () => {
  // A reload landing back on the miner tab mid-investigation is a small
  // thing that happens every single time.
  stubLogs(() => ({ ok: true, body: { lines: ["hello"], total: 1 } }));
  const { unmount } = view();
  await screen.findByText(/hello/);
  await userEvent.click(screen.getByRole("tab", { name: "App events" }));
  expect(await screen.findByLabelText("Filter events")).toBeInTheDocument();
  // The miner view is unmounted, not merely hidden: it holds a
  // subscription and a buffer the hidden tab would keep for nothing.
  expect(screen.queryByLabelText("Filter lines")).not.toBeInTheDocument();

  unmount();
  view();
  expect(await screen.findByLabelText("Filter events")).toBeInTheDocument();
});
