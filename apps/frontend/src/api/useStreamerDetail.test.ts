import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useStreamerDetail } from "./useStreamerDetail.js";

const EMPTY = {
  series: [], events: [], sessions: [],
  coverage: { live: [], mined: [] },
  firstSeen: null, retentionFloor: null,
};

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
    ok: true, status: 200, json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

test("fetches nothing while no streamer is selected", () => {
  const fetchMock = stubFetch(EMPTY);
  renderHook(() => useStreamerDetail(null, "7d"));
  expect(fetchMock).not.toHaveBeenCalled();
});

test("requests the selected streamer and range", async () => {
  const fetchMock = stubFetch(EMPTY);
  renderHook(() => useStreamerDetail("alpha", "7d"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const url = String(fetchMock.mock.calls[0][0]);
  expect(url).toContain("streamer=alpha");
  expect(url).toContain("from=");
  expect(url).toContain("to=");
});

test("exposes the detail once it lands", async () => {
  stubFetch({ ...EMPTY, series: [{ ts: 1000, balance: 10 }] });
  const { result } = renderHook(() => useStreamerDetail("alpha", "7d"));
  await waitFor(() => expect(result.current.detail).not.toBeNull());
  expect(result.current.detail?.series).toEqual([{ ts: 1000, balance: 10 }]);
  expect(result.current.loading).toBe(false);
});

test("reports a failure rather than hanging on loading", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  const { result } = renderHook(() => useStreamerDetail("alpha", "7d"));
  await waitFor(() => expect(result.current.error).not.toBeNull());
  expect(result.current.loading).toBe(false);
});
