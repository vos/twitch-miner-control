import { fireEvent } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { CalendarPayload } from "../api/useInsights.js";
import { HEAT_EMPTY, HEAT_STEPS } from "../lib/heatRamp.js";
import { renderApp } from "../test-utils.js";
import { InsightsCalendar } from "./InsightsCalendar.js";

const day = (date: string, earned: number) => ({ date, earned, minedMs: 0, top: null });

const calendar: CalendarPayload = {
  days: [
    day("2026-09-12", 0), day("2026-09-13", 0), day("2026-09-14", 10),
    day("2026-09-15", 20), day("2026-09-16", 30), day("2026-09-17", 400),
  ],
  since: "2026-09-13",
  streak: { current: 4, longest: 4 },
};

const rect = (container: HTMLElement, date: string) =>
  container.querySelector(`rect[data-date="${date}"]`)!;

test("each day is coloured by its quartile, and before tracking is hatched", () => {
  const { container } = renderApp(<InsightsCalendar calendar={calendar} onPickDay={() => {}} />);
  expect(rect(container, "2026-09-12").getAttribute("fill")).toBe("url(#insights-hatch)");
  expect(rect(container, "2026-09-13").getAttribute("fill")).toBe(HEAT_EMPTY);
  expect(rect(container, "2026-09-14").getAttribute("fill")).toBe(HEAT_STEPS[0]);
  expect(rect(container, "2026-09-17").getAttribute("fill")).toBe(HEAT_STEPS[3]);
});

test("the legend explains the steps and the hatching", () => {
  const { getByTestId } = renderApp(<InsightsCalendar calendar={calendar} onPickDay={() => {}} />);
  expect(getByTestId("calendar-legend")).toHaveTextContent("less");
  expect(getByTestId("calendar-legend")).toHaveTextContent("before tracking began");
});

test("clicking a day hands it up", () => {
  const onPickDay = vi.fn();
  const { container } = renderApp(<InsightsCalendar calendar={calendar} onPickDay={onPickDay} />);
  fireEvent.click(rect(container, "2026-09-15"));
  expect(onPickDay).toHaveBeenCalledWith("2026-09-15");
});
