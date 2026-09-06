import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { StreamerCard } from "./StreamerCard.js";
import type { StreamerState } from "../api/useLiveState.js";

const base: StreamerState = {
  username: "alpha", displayName: "Alpha", channelId: "1",
  points: 1000, isOnline: true, pointsEnabled: true,
  gained24h: 250, gainedSince: null, gainedStream: 40, spark: [900, 950, 1000],
  avatarUrl: null,
  liveSince: null, streamId: null, lastLive: null, lastActivity: null,
  online24h: 0, mined24h: 0, minedTotal: 0, pointsPerHour: null,
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

test("labels a partial window with the span it actually covers", () => {
  // Three hours of history is a real gain over a real window -- it just
  // must not claim to be a full day.
  const now = Date.now();
  view({ gained24h: 120, gainedSince: now - 3 * 3_600_000 });
  const gain = screen.getByTestId("gain-24h");
  expect(gain).toHaveTextContent("+120");
  expect(gain).toHaveTextContent("3h");
  expect(gain).not.toHaveTextContent("24h");
});

test("labels a sub-hour window in minutes rather than rounding to 0h", () => {
  const now = Date.now();
  view({ gained24h: 15, gainedSince: now - 12 * 60_000 });
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("12m");
});

test("labels a full window plainly as 24h", () => {
  view({ gained24h: 250, gainedSince: null });
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("24h");
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

test("marks a live channel with a live pill", () => {
  view({ isOnline: true });
  expect(screen.getByTestId("live-pill")).toBeInTheDocument();
});

test("shows no live pill for an offline channel", () => {
  view({ isOnline: false });
  expect(screen.queryByTestId("live-pill")).not.toBeInTheDocument();
});

test("shows a linked avatar for the streamer", () => {
  const { container } = view({ avatarUrl: "https://cdn/a.png" });
  const link = screen.getByRole("link", { name: /on Twitch/i });
  expect(link).toHaveAttribute("href", "https://twitch.tv/alpha");
  // alt="" is deliberate, so the image is presentational rather than an
  // img role -- the name beside it carries the identity.
  expect(container.querySelector("img")).toHaveAttribute("src", "https://cdn/a.png");
});

test("shows a monogram when the avatar is not known yet", () => {
  const { container } = view({ avatarUrl: null });
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByRole("link", { name: /on Twitch/i })).toBeInTheDocument();
});

test("the streamer's name links to their channel", () => {
  view({ avatarUrl: null });
  const nameLink = screen.getByRole("link", { name: "Alpha" });
  expect(nameLink).toHaveAttribute("href", "https://twitch.tv/alpha");
});

test("ticks the live duration from the stream start", () => {
  view({ isOnline: true, liveSince: Date.now() - 3 * 3_600_000 - 24 * 60_000 });
  expect(screen.getByTestId("live-duration")).toHaveTextContent("3h 24m");
});

test("shows the last activity in the miner's own terms", () => {
  view({ lastActivity: { ts: Date.now() - 4 * 60_000, type: "GAIN_FOR_CLAIM" } });
  const line = screen.getByTestId("last-activity");
  expect(line).toHaveTextContent("claim");
  expect(line).toHaveTextContent("4m ago");
});

test("shows both clocks when they differ", () => {
  view({ online24h: 8 * 3_600_000, mined24h: 6 * 3_600_000 });
  const line = screen.getByTestId("times-24h");
  expect(line).toHaveTextContent("live 8h");
  expect(line).toHaveTextContent("mined 6h");
});

test("collapses to one figure when the clocks agree", () => {
  // "live 6h · mined 6h" on every card is noise; the gap is the signal.
  view({ online24h: 6 * 3_600_000, mined24h: 6 * 3_600_000 });
  const line = screen.getByTestId("times-24h");
  expect(line).toHaveTextContent("mined 6h");
  expect(line).not.toHaveTextContent("live 6h");
});

test("adds the live stream to the 24h figures", () => {
  // The server measures only up to the stream's start, so the card must
  // add the running remainder or a live stream would appear uncounted.
  view({
    isOnline: true,
    liveSince: Date.now() - 2 * 3_600_000,
    online24h: 3_600_000,
    mined24h: 3_600_000,
  });
  expect(screen.getByTestId("times-24h")).toHaveTextContent("3h");
});

test("shows when an offline channel was last live", () => {
  view({ isOnline: false, liveSince: null, lastLive: Date.now() - 3 * 86_400_000 });
  expect(screen.getByTestId("last-live")).toHaveTextContent("3d ago");
});

test("shows the all-time mining figure", () => {
  view({ minedTotal: 142 * 3_600_000 });
  expect(screen.getByTestId("mined-total")).toHaveTextContent("6d");
});

test("shows points per hour when it is reported", () => {
  view({ pointsPerHour: 42.5 });
  expect(screen.getByTestId("points-per-hour")).toHaveTextContent("42.5");
});

test("omits points per hour below the mining floor", () => {
  view({ pointsPerHour: null });
  expect(screen.queryByTestId("points-per-hour")).not.toBeInTheDocument();
});

test("renders nothing rather than zeros without history", () => {
  // "0h mined" and "we have not watched yet" are different claims.
  view({ isOnline: false, liveSince: null, lastLive: null, lastActivity: null });
  expect(screen.queryByTestId("times-24h")).not.toBeInTheDocument();
  expect(screen.queryByTestId("last-live")).not.toBeInTheDocument();
  expect(screen.queryByTestId("live-duration")).not.toBeInTheDocument();
});

test("survives a snapshot missing the time fields entirely", () => {
  // A frame from a backend that predates these fields must degrade to a
  // card without a time block, never throw and blank the dashboard.
  const { liveSince, lastLive, lastActivity, online24h, mined24h, minedTotal,
    pointsPerHour, streamId, ...withoutTimes } = base;
  render(
    <MantineProvider>
      <StreamerCard streamer={withoutTimes as StreamerState} />
    </MantineProvider>,
  );
  expect(screen.getByTestId("balance")).toBeInTheDocument();
  expect(screen.queryByTestId("times-24h")).not.toBeInTheDocument();
});
