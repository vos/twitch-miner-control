import { screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { StreamHistoryTable } from "./StreamHistoryTable.js";

const HOUR = 3_600_000;
const NOW = Date.now();

const session = (over = {}) => ({
  streamId: "s1", start: NOW - 4 * HOUR, end: NOW - 2 * HOUR,
  mined: 2 * HOUR, earned: 500, ...over,
});

test("shows an empty state when no streams are on record", () => {
  renderApp(<StreamHistoryTable sessions={[]} />);
  expect(screen.getByTestId("streams-empty")).toBeInTheDocument();
});

test("renders one row per stream", () => {
  renderApp(
    <StreamHistoryTable sessions={[session(), session({ streamId: "s2" })]} />,
  );
  expect(screen.getAllByTestId("stream-row")).toHaveLength(2);
});

test("shows what a stream earned", () => {
  renderApp(<StreamHistoryTable sessions={[session()]} />);
  expect(screen.getByTestId("stream-row")).toHaveTextContent("+500");
});

test("shows an em-dash, not zero, when the earning is unknown", () => {
  // A session with no anchor balance cannot report earnings. "+0" would
  // claim the stream earned nothing, which is a different fact.
  renderApp(<StreamHistoryTable sessions={[session({ earned: null })]} />);
  const row = screen.getByTestId("stream-row");
  expect(within(row).getByTestId("stream-earned")).toHaveTextContent("—");
  expect(within(row).getByTestId("stream-earned")).not.toHaveTextContent("0");
});

test("marks a stream that was mostly missed", () => {
  renderApp(<StreamHistoryTable sessions={[session({ mined: 6 * 60_000 })]} />);
  expect(screen.getByTestId("low-coverage")).toBeInTheDocument();
});

test("does not mark a well-covered stream", () => {
  renderApp(<StreamHistoryTable sessions={[session({ mined: 2 * HOUR })]} />);
  expect(screen.queryByTestId("low-coverage")).toBeNull();
});

test("marks a still-running stream as live", () => {
  renderApp(
    <StreamHistoryTable sessions={[session({ end: null, start: NOW - HOUR })]} />,
  );
  expect(screen.getByTestId("stream-row")).toHaveTextContent(/live/i);
});

test("caps the table and says how many streams it left out", () => {
  const many = Array.from({ length: 25 }, (_, i) => session({ streamId: `s${i}` }));
  renderApp(<StreamHistoryTable sessions={many} />);
  expect(screen.getAllByTestId("stream-row")).toHaveLength(20);
  expect(screen.getByText(/20 of 25/)).toBeInTheDocument();
});
