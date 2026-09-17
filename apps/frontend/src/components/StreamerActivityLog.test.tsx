import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { StreamerActivityLog } from "./StreamerActivityLog.js";

const NOW = Date.now();

test("shows an empty state when nothing has happened", () => {
  renderApp(<StreamerActivityLog events={[]} />);
  expect(screen.getByTestId("activity-empty")).toBeInTheDocument();
});

test("renders one entry per event", () => {
  renderApp(
    <StreamerActivityLog
      events={[
        { ts: NOW, type: "GAIN_FOR_CLAIM", message: null },
        { ts: NOW - 1000, type: "GAIN_FOR_WATCH", message: null },
      ]}
    />,
  );
  expect(screen.getAllByTestId("activity-entry")).toHaveLength(2);
});

test("shows the amount the miner reported", () => {
  renderApp(
    <StreamerActivityLog
      events={[{
        ts: NOW, type: "GAIN_FOR_CLAIM",
        message: "🚀  +50 → Streamer(username=alpha, channel_points=12.3k) - Reason: CLAIM.",
      }]}
    />,
  );
  expect(screen.getByTestId("activity-entry")).toHaveTextContent("+50");
});

test("falls back to the event label when the message carries no amount", () => {
  // The miner is vendored and can reformat its logs; an unparseable line
  // must lose the amount, never the entry.
  renderApp(
    <StreamerActivityLog
      events={[{ ts: NOW, type: "STREAMER_ONLINE", message: "something unexpected" }]}
    />,
  );
  const entry = screen.getByTestId("activity-entry");
  expect(entry).toBeInTheDocument();
  expect(entry).not.toHaveTextContent("+");
});

test("groups entries under a day heading", () => {
  renderApp(
    <StreamerActivityLog
      events={[
        { ts: NOW, type: "GAIN_FOR_CLAIM", message: null },
        { ts: NOW - 3 * 86_400_000, type: "GAIN_FOR_CLAIM", message: null },
      ]}
    />,
  );
  expect(screen.getAllByTestId("activity-day")).toHaveLength(2);
});

test("the feed reserves a gutter so the scrollbar cannot cover the times", () => {
  // The overlay scrollbar sat on top of the right-hand time column once
  // the feed was tall enough to scroll, which the dialog's standalone
  // Activity view made the normal case.
  const events = Array.from({ length: 40 }, (_, i) => ({
    ts: Date.now() - i * 60_000, type: "GAIN_FOR_CLAIM", message: "+50",
  }));
  renderApp(<StreamerActivityLog events={events} />);
  const viewport = screen.getAllByTestId("activity-entry")[0]
    .closest(".mantine-ScrollArea-viewport");
  expect(viewport).toHaveAttribute("data-offset-scrollbars", "y");
  // "y" and not "present": Mantine gates the gutter on
  // :not([data-vertical-hidden]), so a feed short enough not to scroll
  // keeps the full width rather than gaining a gap beside nothing.
  expect(viewport).not.toHaveAttribute("data-offset-scrollbars", "present");
});

test("a run of identical events becomes one row with a count badge", () => {
  const offline = (min: number) =>
    ({ ts: new Date(2026, 8, 17, 10, min).getTime(), type: "STREAMER_OFFLINE", message: null });
  renderApp(<StreamerActivityLog events={[offline(30), offline(20), offline(10)]} />);
  expect(screen.getAllByTestId("activity-entry")).toHaveLength(1);
  expect(screen.getByTestId("activity-count")).toHaveTextContent("×3");
});

test("a single event gets no badge", () => {
  // The badge is a multiplier; "×1" on every other row would be noise.
  renderApp(<StreamerActivityLog events={[
    { ts: Date.now(), type: "STREAMER_OFFLINE", message: null },
  ]} />);
  expect(screen.queryByTestId("activity-count")).toBeNull();
});

test("a collapsed run reports the points the whole run earned", () => {
  // Three ten-point gains are thirty; showing one and hiding two would
  // put the feed at odds with the balance above it.
  const watch = (min: number) => ({
    ts: new Date(2026, 8, 17, 10, min).getTime(),
    type: "GAIN_FOR_WATCH",
    message: "+10 → Streamer(username=a) - Reason: WATCH.",
  });
  renderApp(<StreamerActivityLog events={[watch(30), watch(20), watch(10)]} />);
  expect(screen.getByTestId("activity-entry")).toHaveTextContent("+30");
  expect(screen.getByTestId("activity-count")).toHaveTextContent("×3");
});

test("a run does not fold across a day heading", () => {
  // Each row sits under the date it describes; a row under one heading
  // must not silently count events from the day before.
  const offline = (d: number, h: number) =>
    ({ ts: new Date(2026, 8, d, h, 0).getTime(), type: "STREAMER_OFFLINE", message: null });
  renderApp(<StreamerActivityLog events={[
    offline(17, 9), offline(17, 8), offline(16, 22), offline(16, 21),
  ]} />);
  expect(screen.getAllByTestId("activity-day")).toHaveLength(2);
  expect(screen.getAllByTestId("activity-entry")).toHaveLength(2);
  for (const badge of screen.getAllByTestId("activity-count")) {
    expect(badge).toHaveTextContent("×2");
  }
});
