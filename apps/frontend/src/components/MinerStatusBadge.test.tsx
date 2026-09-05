import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { MinerStatusBadge } from "./MinerStatusBadge.js";

test("shows the miner state", () => {
  renderApp(<MinerStatusBadge state="RUNNING" startedAt={null} />);
  expect(screen.getByTestId("miner-state")).toHaveTextContent("RUNNING");
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
