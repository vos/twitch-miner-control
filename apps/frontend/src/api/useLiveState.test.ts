import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useLiveState } from "./useLiveState.js";

const initial = { streamers: [], lastUpdated: 1, stale: false, error: null };

class FakeEventSource {
  static last: FakeEventSource | null = null;
  handlers = new Map<string, (e: MessageEvent) => void>();
  constructor(public url: string) { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.handlers.set(type, fn);
  }
  emit(type: string, data: unknown) {
    this.handlers.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
  // Drives the connection indicator directly, bypassing the "state" event
  // handler -- the source of truth for connectivity is EventSource's own
  // lifecycle, not whether a frame happened to arrive.
  fail() {
    this.handlers.get("error")?.({} as MessageEvent);
  }
  open() {
    this.handlers.get("open")?.({} as MessageEvent);
  }
  close() {}
}

afterEach(() => { vi.unstubAllGlobals(); });

function setup() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => initial,
  })));
  vi.stubGlobal("EventSource", FakeEventSource);
  return renderHook(() => useLiveState());
}

test("seeds from the REST snapshot", async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.snapshot).toEqual(initial));
});

test("replaces the snapshot when a state event arrives", async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  const updated = { ...initial, lastUpdated: 2,
                    streamers: [{ username: "alpha", points: 5 }] };
  FakeEventSource.last!.emit("state", updated);
  await waitFor(() => expect(result.current.snapshot!.lastUpdated).toBe(2));
});

test("ignores a malformed frame instead of crashing", async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  FakeEventSource.last!.handlers.get("state")!({ data: "not json" } as MessageEvent);
  expect(result.current.snapshot).toEqual(initial);
});

test("connected becomes true when the stream opens", async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  expect(result.current.connected).toBe(false);
  act(() => { FakeEventSource.last!.open(); });
  await waitFor(() => expect(result.current.connected).toBe(true));
});

test("connected drops to false when the stream errors, and recovers on reconnect", async () => {
  const { result } = setup();
  await waitFor(() => expect(result.current.snapshot).not.toBeNull());
  act(() => { FakeEventSource.last!.open(); });
  await waitFor(() => expect(result.current.connected).toBe(true));

  act(() => { FakeEventSource.last!.fail(); });
  await waitFor(() => expect(result.current.connected).toBe(false));

  // EventSource reconnects automatically; "open" fires again on recovery.
  act(() => { FakeEventSource.last!.open(); });
  await waitFor(() => expect(result.current.connected).toBe(true));
});
