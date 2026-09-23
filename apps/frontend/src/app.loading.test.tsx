import { act, cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { renderApp } from "./test-utils.js";

// The Insights chunk, held until the test lets it through.
let release!: () => void;
const gate = new Promise<void>((resolve) => { release = resolve; });
vi.mock("./routes/Insights.js", async () => {
  await gate;
  return { Insights: () => <div data-testid="insights-loaded" /> };
});

const { App } = await import("./app.js");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("Insights shows a loader while its code is still on the way", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url === "/api/status"
      ? { miner: "RUNNING", loginRequired: false, login: null, startedAt: null }
      : { streamers: [], lastUpdated: null, stale: true, error: null, lines: [] }),
  })));
  vi.stubGlobal("EventSource", class {
    addEventListener() {}
    close() {}
  });
  renderApp(<App />);
  await userEvent.click(await screen.findByRole("button", { name: /^Insights/ }));
  expect(await screen.findByRole("status", { name: "Loading Insights" })).toBeInTheDocument();

  await act(async () => { release(); await gate; });
  expect(await screen.findByTestId("insights-loaded")).toBeInTheDocument();
  expect(screen.queryByRole("status", { name: "Loading Insights" })).toBeNull();
});
