import { screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { CoverageTimeline } from "./CoverageTimeline.js";

const HOUR = 3_600_000;
// Local noon: the spans below reach four hours back, and the strip splits
// at local midnight, so a real clock read just after midnight would move
// them onto yesterday's row.
const NOW = new Date(2026, 8, 16, 12).getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

test("renders one row per day the channel streamed", () => {
  // Seven days requested, three of them streamed: the four the channel
  // was dark do not each earn a row of em dashes.
  const dayAgo = (n: number) => new Date(2026, 8, 16 - n, 10).getTime();
  renderApp(
    <CoverageTimeline
      coverage={{
        live: [0, 1, 2].map((n) => ({ start: dayAgo(n), end: dayAgo(n) + HOUR })),
        mined: [],
      }}
      days={7}
    />,
  );
  expect(screen.getAllByTestId("coverage-day")).toHaveLength(3);
});

test("draws a band for a stream", () => {
  renderApp(
    <CoverageTimeline
      coverage={{ live: [{ start: NOW - 3 * HOUR, end: NOW - HOUR }], mined: [] }}
      days={1}
    />,
  );
  expect(screen.getAllByTestId("live-band").length).toBeGreaterThan(0);
});

test("draws the mined stretch over the live one", () => {
  renderApp(
    <CoverageTimeline
      coverage={{
        live: [{ start: NOW - 3 * HOUR, end: NOW }],
        mined: [{ start: NOW - HOUR, end: NOW }],
      }}
      days={1}
    />,
  );
  expect(screen.getAllByTestId("mined-band").length).toBeGreaterThan(0);
});

test("reports mined against live hours for the day", () => {
  renderApp(
    <CoverageTimeline
      coverage={{
        live: [{ start: NOW - 4 * HOUR, end: NOW }],
        mined: [{ start: NOW - HOUR, end: NOW }],
      }}
      days={1}
    />,
  );
  expect(screen.getByTestId("coverage-total")).toHaveTextContent("1h");
  expect(screen.getByTestId("coverage-total")).toHaveTextContent("4h");
});

test("a lone dark day between two streaming ones keeps its row", () => {
  // One quiet day costs a row either way, and "1 day dark" is wider than
  // the date it would replace -- so it stays a dated row, em dash and all.
  const at = (n: number) => new Date(2026, 8, 16 - n, 10).getTime();
  renderApp(
    <CoverageTimeline
      coverage={{
        live: [{ start: at(0), end: at(0) + HOUR }, { start: at(2), end: at(2) + HOUR }],
        mined: [],
      }}
      days={7}
    />,
  );
  expect(screen.getAllByTestId("coverage-day")).toHaveLength(3);
  expect(screen.queryByTestId("coverage-gap")).toBeNull();
  expect(screen.getAllByTestId("coverage-total")[1]).toHaveTextContent("—");
});

test("a run of dark days collapses into one line", () => {
  const at = (n: number) => new Date(2026, 8, 16 - n, 10).getTime();
  renderApp(
    <CoverageTimeline
      coverage={{
        live: [{ start: at(0), end: at(0) + HOUR }, { start: at(5), end: at(5) + HOUR }],
        mined: [],
      }}
      days={7}
    />,
  );
  expect(screen.getAllByTestId("coverage-day")).toHaveLength(2);
  expect(screen.getByTestId("coverage-gap")).toHaveTextContent("4 days dark");
});

test("a channel that never streamed says so instead of drawing a strip", () => {
  renderApp(<CoverageTimeline coverage={{ live: [], mined: [] }} days={7} />);
  expect(screen.getByTestId("coverage-empty")).toBeInTheDocument();
  expect(screen.queryByTestId("coverage-day")).toBeNull();
});

test("the mined band is dimmed below the full success green", () => {
  // It fills whole rows when the miner runs for days, where the
  // undimmed token glowed. It must still sit above the live tone
  // beneath it, or the mined/live comparison stops reading.
  renderApp(
    <CoverageTimeline
      coverage={{
        live: [{ start: NOW - 3 * HOUR, end: NOW }],
        mined: [{ start: NOW - 3 * HOUR, end: NOW }],
      }}
      days={1}
    />,
  );
  const opacity = (el: Element | null) => Number(el?.getAttribute("fill-opacity"));
  const mined = opacity(screen.getAllByTestId("mined-band")[0]);
  const live = opacity(screen.getAllByTestId("live-band")[0]);
  expect(mined).toBeLessThan(1);
  expect(mined).toBeGreaterThan(live);
});
