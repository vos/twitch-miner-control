import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { MinerDock } from "./MinerDock.js";

afterEach(() => vi.unstubAllGlobals());

function stubPost(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok, status: ok ? 200 : 500, json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

test("offers Stop when the miner is up", () => {
  stubPost({});
  renderApp(<MinerDock state="RUNNING" onChange={() => {}} />);
  expect(screen.getByTestId("miner-toggle")).toHaveTextContent("Stop");
});

test("offers Start when the miner is down", () => {
  stubPost({});
  renderApp(<MinerDock state="STOPPED" onChange={() => {}} />);
  expect(screen.getByTestId("miner-toggle")).toHaveTextContent("Start");
});

test("disables both actions while the miner is between lives", () => {
  stubPost({});
  renderApp(<MinerDock state="STARTING" onChange={() => {}} />);
  expect(screen.getByTestId("miner-toggle")).toBeDisabled();
  expect(screen.getByTestId("miner-restart")).toBeDisabled();
});

test("reports the settled state from the action's own response", async () => {
  // The response is the freshest answer there is -- the UI must not wait
  // for the next 5s poll to reflect what just happened.
  stubPost({ state: "STOPPED", startedAt: null });
  const onChange = vi.fn();
  renderApp(<MinerDock state="RUNNING" onChange={onChange} />);
  await userEvent.click(screen.getByTestId("miner-toggle"));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({ state: "STOPPED", startedAt: null }),
  );
});

test("shows a failed action's message in full, not behind a tooltip", async () => {
  // The reason this moved out of the header: there it was clamped to one
  // line at maw=180 with the real text hidden in a tooltip.
  stubPost({ error: "spawn failed: ENOENT" }, false);
  renderApp(<MinerDock state="STOPPED" onChange={() => {}} />);
  await userEvent.click(screen.getByTestId("miner-toggle"));
  expect(await screen.findByTestId("miner-error")).toHaveTextContent("spawn failed: ENOENT");
});
