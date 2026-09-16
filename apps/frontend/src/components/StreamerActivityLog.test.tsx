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
