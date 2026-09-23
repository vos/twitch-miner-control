import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderLive } from "../test-utils.js";

// The dialog's chunk, held until a test lets it through: this file is
// about what shows while the lazy import is still in flight.
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
let mounts = 0;
vi.mock("./StreamerDetailModal.js", async () => {
  await gate;
  const { useEffect } = await import("react");
  return {
    StreamerDetailModal: ({ opened }: { opened: boolean }) => {
      useEffect(() => { mounts += 1; }, []);
      return opened ? <div data-testid="detail-title">loaded</div> : null;
    },
  };
});

const { StreamerDetailHost } = await import("./StreamerDetailHost.js");

const snapshot = {
  lastUpdated: Date.now(), stale: false, error: null,
  streamers: [
    { username: "beta", displayName: "Beta", points: 20, isOnline: false,
      channelId: "2", pointsEnabled: true, avatarUrl: null,
      gained24h: 0, gainedSince: null, gainedStream: null, spark: [] },
  ],
};

let idle: Array<() => void>;
beforeEach(() => {
  idle = [];
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
    idle.push(callback);
    return idle.length;
  });
  vi.stubGlobal("cancelIdleCallback", () => {});
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => snapshot,
  })));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
});
// Unmounted before the stubs go: unmounting cancels the idle callback.
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** A host whose parent can re-render it on demand, as live updates do. */
function Harness() {
  const [tick, setTick] = useState(0);
  return (
    <>
      <button onClick={() => setTick(tick + 1)}>rerender {tick}</button>
      <StreamerDetailHost login="beta" onClose={() => {}} />
    </>
  );
}

test("a dialog opens at once, naming the streamer, while its code still loads", async () => {
  renderLive(<Harness />);
  const loading = await screen.findByTestId("detail-code-loading");
  expect(loading).toHaveAccessibleName("Loading details");
  expect(await screen.findByText("Beta")).toBeInTheDocument();
  expect(screen.queryByTestId("detail-title")).toBeNull();

  await act(async () => { release(); await gate; });
  expect(await screen.findByTestId("detail-title")).toHaveTextContent("loaded");
  expect(screen.queryByTestId("detail-code-loading")).toBeNull();

  // Opened on the lazy path, it keeps that path: switching to the loaded
  // component now would remount the open dialog, resetting its range and
  // refetching its history on the next live update.
  const before = mounts;
  await userEvent.click(screen.getByRole("button", { name: /rerender/ }));
  await userEvent.click(screen.getByRole("button", { name: /rerender/ }));
  expect(mounts).toBe(before);
});

test("the dialog's code is fetched when the browser is idle, not before", () => {
  renderLive(<StreamerDetailHost login={null} onClose={() => {}} />);
  // Scheduled, not run: the first paint never waits on it.
  expect(idle).toHaveLength(1);
});

