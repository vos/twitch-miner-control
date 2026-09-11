import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { MinerStatusBadge } from "./MinerStatusBadge.js";

test("shows the miner state", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={null} />);
  expect(screen.getByTestId("miner-state")).toHaveTextContent("RUNNING");
});

test("shows a placeholder, not a state, until the first poll answers", () => {
  // An orange badge reading "…" claims the miner is down before anything
  // has said so.
  renderApp(<MinerStatusBadge state={null} startedAt={null} />);
  expect(screen.queryByTestId("miner-state")).not.toBeInTheDocument();
  expect(screen.getByTestId("miner-state-loading")).toBeInTheDocument();
});

test("shows uptime when the miner is up", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={Date.now() - 90_000} />);
  expect(screen.getByTestId("miner-uptime")).toHaveTextContent("1m 30s");
});

test("shows no uptime when nothing is running", () => {
  renderApp(<MinerStatusBadge state="STOPPED" startedAt={null} />);
  expect(screen.queryByTestId("miner-uptime")).not.toBeInTheDocument();
});

test("carries no action buttons -- those live in the sidebar dock", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={null} />);
  expect(screen.queryByTestId("miner-toggle")).not.toBeInTheDocument();
  expect(screen.queryByTestId("miner-restart")).not.toBeInTheDocument();
});

const history = (cpus: (number | null)[]) =>
  cpus.map((cpu, i) => ({ at: i * 1000, cpu, rssBytes: 148 * 1024 * 1024 }));

test("shows cpu and memory for a running miner", () => {
  renderApp(
    <MinerStatusBadge state="RUNNING" startedAt={null} history={history([10, 20])} />,
  );
  expect(screen.getByTestId("miner-stats")).toHaveTextContent("15%");
  expect(screen.getByTestId("miner-stats")).toHaveTextContent("148 MB");
});

test("labels the average by the window it actually covers", () => {
  renderApp(
    <MinerStatusBadge state="RUNNING" startedAt={null} history={history([10, 20])} />,
  );
  // Two samples is 10 seconds of history, not the minute it settles on.
  expect(screen.getByTestId("miner-stats")).toHaveTextContent("10s avg");
});

test("shows memory before any cpu figure can be computed", () => {
  renderApp(
    <MinerStatusBadge state="RUNNING" startedAt={null} history={history([null])} />,
  );
  // Memory is an instantaneous read, so it is there from the first poll
  // even though cpu needs a second sample to form a delta.
  expect(screen.getByTestId("miner-stats")).toHaveTextContent("148 MB");
  expect(screen.getByTestId("miner-stats")).not.toHaveTextContent("%");
});

test("shows no stats when the miner is not running", () => {
  renderApp(<MinerStatusBadge state="STOPPED" startedAt={null} history={[]} />);
  expect(screen.queryByTestId("miner-stats")).not.toBeInTheDocument();
});

test("graphs the cpu history once there is a trend to draw", () => {
  renderApp(
    <MinerStatusBadge state="RUNNING" startedAt={null} history={history([10, 20, 30])} />,
  );
  expect(screen.getByTestId("miner-cpu-graph")).toBeInTheDocument();
});

test("draws no graph from a single reading", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={null} history={history([10])} />);
  // One point is not a trend; the numbers still show.
  expect(screen.queryByTestId("miner-cpu-graph")).not.toBeInTheDocument();
  expect(screen.getByTestId("miner-stats")).toBeInTheDocument();
});
