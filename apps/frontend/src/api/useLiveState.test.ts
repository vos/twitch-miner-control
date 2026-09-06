import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { DISCONNECT_GRACE_MS, RECONNECT_DELAY_MS, useLiveState } from "./useLiveState.js";

const initial = { streamers: [], lastUpdated: 1, stale: false, error: null };

class FakeEventSource {
  static last: FakeEventSource | null = null;
  static created: FakeEventSource[] = [];
  closed = false;
  handlers = new Map<string, (e: MessageEvent) => void>();
  constructor(public url: string) {
    FakeEventSource.last = this;
    FakeEventSource.created.push(this);
  }
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
  close() { this.closed = true; }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.created = [];
  FakeEventSource.last = null;
});

function setup() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => initial,
  })));
  vi.stubGlobal("EventSource", FakeEventSource);
  return renderHook(() => useLiveState());
}

/** setup() whose probe of /api/status answers 401, i.e. the session expired. */
function setupWithExpiredSession() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false, status: 401, json: async () => ({ error: "unauthorized" }),
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
  vi.useFakeTimers();
  try {
    const { result } = setup();
    await vi.waitFor(() => expect(result.current.snapshot).not.toBeNull());
    act(() => { FakeEventSource.last!.open(); });
    expect(result.current.connected).toBe(true);

    // A drop is only reported once it outlasts DISCONNECT_GRACE_MS; see
    // the grace-window tests below for the short-drop case.
    act(() => { FakeEventSource.last!.fail(); });
    act(() => { vi.advanceTimersByTime(DISCONNECT_GRACE_MS + 100); });
    expect(result.current.connected).toBe(false);

    // EventSource reconnects automatically; "open" fires again on recovery.
    act(() => { FakeEventSource.last!.open(); });
    expect(result.current.connected).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a brief drop does not flip connected, since EventSource reconnects on its own", async () => {
  vi.useFakeTimers();
  try {
    const { result } = setup();
    await vi.waitFor(() => expect(result.current.snapshot).not.toBeNull());
    act(() => { FakeEventSource.last!.open(); });
    expect(result.current.connected).toBe(true);

    // EventSource drops and recovers well inside the grace window -- the
    // badge must not flicker for something the user cannot act on.
    act(() => { FakeEventSource.last!.fail(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current.connected).toBe(true);

    act(() => { FakeEventSource.last!.open(); });
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(result.current.connected).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a drop that outlasts the grace window reports disconnected", async () => {
  vi.useFakeTimers();
  try {
    const { result } = setup();
    await vi.waitFor(() => expect(result.current.snapshot).not.toBeNull());
    act(() => { FakeEventSource.last!.open(); });
    expect(result.current.connected).toBe(true);

    act(() => { FakeEventSource.last!.fail(); });
    act(() => { vi.advanceTimersByTime(DISCONNECT_GRACE_MS + 100); });

    expect(result.current.connected).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});


test("rebuilds the EventSource after a drop, since it does not retry an HTTP error", async () => {
  vi.useFakeTimers();
  try {
    const { result } = setup();
    await vi.waitFor(() => expect(result.current.snapshot).not.toBeNull());
    act(() => { FakeEventSource.last!.open(); });
    expect(FakeEventSource.created).toHaveLength(1);

    // A 401/502 surfaces as "error" with no "open" and no built-in retry,
    // so the hook must construct a fresh source itself.
    act(() => { FakeEventSource.last!.fail(); });
    await act(async () => {
      vi.advanceTimersByTime(RECONNECT_DELAY_MS + 100);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(FakeEventSource.created.length).toBeGreaterThan(1);
    expect(FakeEventSource.created[0].closed).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("a rebuilt stream that opens clears the disconnected state", async () => {
  vi.useFakeTimers();
  try {
    const { result } = setup();
    await vi.waitFor(() => expect(result.current.snapshot).not.toBeNull());
    act(() => { FakeEventSource.last!.open(); });

    act(() => { FakeEventSource.last!.fail(); });
    act(() => { vi.advanceTimersByTime(DISCONNECT_GRACE_MS + 100); });
    expect(result.current.connected).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(RECONNECT_DELAY_MS + 100);
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => { FakeEventSource.last!.open(); });

    expect(result.current.connected).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("reports authExpired when the stream fails and the session is gone", async () => {
  vi.useFakeTimers();
  try {
    const { result } = setupWithExpiredSession();
    act(() => { FakeEventSource.last!.fail(); });
    await act(async () => {
      vi.advanceTimersByTime(RECONNECT_DELAY_MS + 100);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.authExpired).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("does not report authExpired when the session is still valid", async () => {
  vi.useFakeTimers();
  try {
    const { result } = setup();
    await vi.waitFor(() => expect(result.current.snapshot).not.toBeNull());
    act(() => { FakeEventSource.last!.open(); });

    act(() => { FakeEventSource.last!.fail(); });
    await act(async () => {
      vi.advanceTimersByTime(RECONNECT_DELAY_MS + 100);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.authExpired).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test("stops reconnecting once the session has expired", async () => {
  vi.useFakeTimers();
  try {
    const { result } = setupWithExpiredSession();
    act(() => { FakeEventSource.last!.fail(); });
    await act(async () => {
      vi.advanceTimersByTime(RECONNECT_DELAY_MS + 100);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.authExpired).toBe(true);

    const afterAuthFailure = FakeEventSource.created.length;
    await act(async () => {
      vi.advanceTimersByTime(RECONNECT_DELAY_MS * 6);
      await vi.advanceTimersByTimeAsync(0);
    });

    // Reconnecting against a dead cookie would 401 forever; the app must
    // send the user through the login gate instead.
    expect(FakeEventSource.created).toHaveLength(afterAuthFailure);
  } finally {
    vi.useRealTimers();
  }
});

test("retry clears authExpired and opens a fresh stream", async () => {
  vi.useFakeTimers();
  try {
    const { result } = setupWithExpiredSession();
    act(() => { FakeEventSource.last!.fail(); });
    await act(async () => {
      vi.advanceTimersByTime(RECONNECT_DELAY_MS + 100);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.authExpired).toBe(true);

    // The user logged back in, so the cookie the hook gave up on has been
    // replaced -- the stream has to be rebuilt or the dashboard renders
    // with no live updates until a manual refresh.
    const beforeRetry = FakeEventSource.created.length;
    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.authExpired).toBe(false);
    expect(FakeEventSource.created.length).toBeGreaterThan(beforeRetry);
  } finally {
    vi.useRealTimers();
  }
});
