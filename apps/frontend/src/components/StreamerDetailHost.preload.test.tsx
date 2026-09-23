import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderLive } from "../test-utils.js";
import { StreamerDetailHost } from "./StreamerDetailHost.js";

vi.mock("./StreamerDetailModal.js", () => ({
  StreamerDetailModal: ({ opened }: { opened: boolean }) =>
    (opened ? <div data-testid="detail-title">loaded</div> : null),
}));

let idle: Array<() => void>;
beforeEach(() => {
  idle = [];
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => idle.push(callback));
  vi.stubGlobal("cancelIdleCallback", () => {});
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ lastUpdated: null, stale: true, error: null, streamers: [] }),
  })));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness() {
  const [login, setLogin] = useState<string | null>(null);
  return (
    <>
      <button onClick={() => setLogin("beta")}>open</button>
      <StreamerDetailHost login={login} onClose={() => setLogin(null)} />
    </>
  );
}

test("once preloaded, opening a dialog never passes through the loader", async () => {
  renderLive(<Harness />);
  // The idle preload runs and its import settles before any click.
  await act(async () => {
    for (const run of idle) run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const seen: boolean[] = [];
  const observer = new MutationObserver(() => {
    seen.push(document.querySelector('[data-testid="detail-code-loading"]') !== null);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  await userEvent.click(screen.getByText("open"));
  expect(await screen.findByTestId("detail-title")).toBeInTheDocument();
  observer.disconnect();
  // Not even for a frame: a loader flashing up and straight away being
  // replaced reads as the dialog flickering.
  expect(seen.some(Boolean)).toBe(false);
});
