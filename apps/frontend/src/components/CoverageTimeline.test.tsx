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

test("renders one row per day requested", () => {
  renderApp(<CoverageTimeline coverage={{ live: [], mined: [] }} days={7} />);
  expect(screen.getAllByTestId("coverage-day")).toHaveLength(7);
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

test("a day with no streams reports an em-dash rather than zero of zero", () => {
  renderApp(<CoverageTimeline coverage={{ live: [], mined: [] }} days={1} />);
  expect(screen.getByTestId("coverage-total")).toHaveTextContent("—");
});
