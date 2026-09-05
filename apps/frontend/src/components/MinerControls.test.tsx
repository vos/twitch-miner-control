import { MantineProvider } from "@mantine/core";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MinerControls } from "./MinerControls.js";

const view = (props: Parameters<typeof MinerControls>[0]) =>
  render(<MantineProvider><MinerControls {...props} /></MantineProvider>);

const base = { state: "RUNNING", startedAt: null, onChange: () => {} };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ state: "STOPPED", startedAt: null }),
  })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test("shows the miner state", () => {
  view({ ...base, state: "RUNNING" });
  expect(screen.getByTestId("miner-state")).toHaveTextContent("RUNNING");
});

test("offers Stop while the miner is running", () => {
  view({ ...base, state: "RUNNING" });
  expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
});

test("offers Start while the miner is stopped", () => {
  view({ ...base, state: "STOPPED" });
  expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
});

test("offers Start after a crash, so an operator can recover without a page reload", () => {
  view({ ...base, state: "CRASHED" });
  expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
});

test("disables the toggle mid-transition, when neither Start nor Stop is meaningful", () => {
  view({ ...base, state: "STARTING" });
  expect(screen.getByTestId("miner-toggle")).toBeDisabled();
});

test("posts to the stop route when Stop is pressed", async () => {
  view({ ...base, state: "RUNNING" });
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/miner/stop", expect.objectContaining({ method: "POST" })));
});

test("posts to the start route when Start is pressed", async () => {
  view({ ...base, state: "STOPPED" });
  await userEvent.click(screen.getByRole("button", { name: "Start" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/miner/start", expect.objectContaining({ method: "POST" })));
});

test("posts to the restart route when Restart is pressed", async () => {
  view({ ...base, state: "RUNNING" });
  await userEvent.click(screen.getByRole("button", { name: "Restart" }));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/api/miner/restart", expect.objectContaining({ method: "POST" })));
});

test("hands the new state back to the parent so the header updates without waiting for a poll", async () => {
  const onChange = vi.fn();
  view({ ...base, state: "RUNNING", onChange });
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({ state: "STOPPED", startedAt: null }));
});

test("surfaces a failed action instead of silently doing nothing", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: false, status: 500, json: async () => ({ error: "miner is wedged" }),
  })));
  view({ ...base, state: "RUNNING" });
  await userEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("miner is wedged");
});

test("renders no timer when no miner is running", () => {
  view({ ...base, state: "STOPPED", startedAt: null });
  expect(screen.queryByTestId("miner-uptime")).not.toBeInTheDocument();
});

test("renders the uptime for a running miner", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
  const startedAt = Date.now() - (2 * 3_600_000 + 14 * 60_000 + 3_000);
  view({ ...base, state: "RUNNING", startedAt });
  expect(screen.getByTestId("miner-uptime")).toHaveTextContent("2h 14m 03s");
});

test("advances the uptime every second without a new server response", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
  const startedAt = Date.now() - 5_000;
  view({ ...base, state: "RUNNING", startedAt });
  expect(screen.getByTestId("miner-uptime")).toHaveTextContent("5s");
  // The interval's setState lands outside React's own batching, so the
  // advance has to be wrapped or React warns about an unacted update.
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(screen.getByTestId("miner-uptime")).toHaveTextContent("8s");
});
