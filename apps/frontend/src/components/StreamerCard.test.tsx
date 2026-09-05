import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { StreamerCard } from "./StreamerCard.js";
import type { StreamerState } from "../api/useLiveState.js";

const base: StreamerState = {
  username: "alpha", displayName: "Alpha", channelId: "1",
  points: 1000, isOnline: true, pointsEnabled: true,
  gained24h: 250, gainedStream: 40, spark: [900, 950, 1000],
};

const view = (streamer: Partial<StreamerState> = {}) =>
  render(
    <MantineProvider><StreamerCard streamer={{ ...base, ...streamer }} /></MantineProvider>,
  );

test("shows the exact balance, not an abbreviated one", () => {
  view({ points: 1234567 });
  expect(screen.getByText("1,234,567")).toBeInTheDocument();
});

test("shows both gains for a live streamer", () => {
  view();
  expect(screen.getByTestId("gain-stream")).toHaveTextContent("+40");
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("+250");
});

test("omits stream gain when the streamer is offline", () => {
  view({ isOnline: false, gainedStream: null });
  expect(screen.queryByTestId("gain-stream")).not.toBeInTheDocument();
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("+250");
});

test("distinguishes an unknown gain from a genuine zero", () => {
  view({ gained24h: null });
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("—");
  view({ gained24h: 0 });
  expect(screen.getAllByTestId("gain-24h").at(-1)).toHaveTextContent("0");
});

test("signs a negative gain rather than showing a bare number", () => {
  view({ gained24h: -30 });
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("-30");
});

test("warns when channel points are disabled, since the balance is frozen", () => {
  view({ pointsEnabled: false });
  expect(screen.getByTestId("points-disabled")).toBeInTheDocument();
});

test("surfaces a per-streamer error", () => {
  view({ error: "channel lookup failed" });
  expect(screen.getByRole("alert")).toHaveTextContent("channel lookup failed");
});

test("shows a placeholder when the balance is unknown", () => {
  view({ points: null });
  expect(screen.getByTestId("balance")).toHaveTextContent("—");
});
