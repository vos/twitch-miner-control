import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { PointsChart } from "./PointsChart.js";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

const series = [
  { ts: NOW - 3 * HOUR, balance: 100 },
  { ts: NOW - HOUR, balance: 180 },
];

test("shows an empty state rather than a blank chart", () => {
  renderApp(
    <PointsChart series={[]} range="24h" from={NOW - 24 * HOUR} to={NOW} retentionFloor={null} />,
  );
  expect(screen.getByTestId("points-chart-empty")).toBeInTheDocument();
});

test("renders the chart once there is a series", () => {
  renderApp(
    <PointsChart series={series} range="24h" from={NOW - 24 * HOUR} to={NOW} retentionFloor={null} />,
  );
  expect(screen.getByTestId("points-chart")).toBeInTheDocument();
  expect(screen.queryByTestId("points-chart-empty")).toBeNull();
});

test("offers both a balance and a gain view", async () => {
  renderApp(
    <PointsChart series={series} range="24h" from={NOW - 24 * HOUR} to={NOW} retentionFloor={null} />,
  );
  const toggle = screen.getByTestId("points-chart-view");
  expect(toggle).toBeInTheDocument();
  await userEvent.click(screen.getByRole("radio", { name: /gain/i }));
  expect(screen.getByTestId("points-chart")).toBeInTheDocument();
});

test("names the retention floor on the all range", () => {
  // Otherwise a channel tracked for two years looks like it began at the
  // pruning cutoff.
  renderApp(
    <PointsChart
      series={series} range="all" from={0} to={NOW}
      retentionFloor={NOW - 90 * 24 * HOUR}
    />,
  );
  expect(screen.getByTestId("retention-note")).toBeInTheDocument();
});

test("does not claim a retention floor on a short range", () => {
  renderApp(
    <PointsChart
      series={series} range="24h" from={NOW - 24 * HOUR} to={NOW}
      retentionFloor={NOW - 90 * 24 * HOUR}
    />,
  );
  expect(screen.queryByTestId("retention-note")).toBeNull();
});
