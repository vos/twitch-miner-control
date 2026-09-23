import { MantineProvider } from "@mantine/core";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { HEAT_EMPTY, HEAT_STEPS } from "../lib/heatRamp.js";
import { renderApp } from "../test-utils.js";
import { theme } from "../theme.js";
import { LiveSchedule } from "./LiveSchedule.js";

// Local time; the 7th and 21st of September 2026 are Mondays.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).getTime();
const TUE_20 = 1 * 24 + 20;

const data = {
  since: at(7, 0),
  now: at(21, 0),
  spans: [
    { start: at(8, 20, 0), end: at(8, 20, 30) },
    { start: at(15, 20, 0), end: at(15, 20, 30) },
    { start: at(9, 20, 0), end: at(9, 20, 30) },
  ],
};

afterEach(() => vi.useRealTimers());

const cellAt = (hour: number) =>
  screen.getAllByTestId("schedule-cell").find((c) => c.dataset.hour === String(hour))!;

test("draws one cell per hour of the week", () => {
  renderApp(<LiveSchedule data={data} error={null} />);
  expect(screen.getAllByTestId("schedule-cell")).toHaveLength(168);
});

test("colours by how often the channel was live in that hour", () => {
  renderApp(<LiveSchedule data={data} error={null} />);
  expect(cellAt(TUE_20).style.backgroundColor).toBe(hexToRgb(HEAT_STEPS[3])); // 2 of 2
  expect(cellAt(2 * 24 + 20).style.backgroundColor).toBe(hexToRgb(HEAT_STEPS[1])); // Wed, 1 of 2
  expect(cellAt(0).style.backgroundColor).toBe(hexToRgb(HEAT_EMPTY)); // never
});

test("each cell says what it means, on hover and to a screen reader", async () => {
  renderApp(<LiveSchedule data={data} error={null} />);
  expect(cellAt(TUE_20)).toHaveAttribute("aria-label", "Tuesdays 20:00–21:00 · live 2 of 2 weeks");
  await userEvent.hover(cellAt(23));
  expect(await screen.findByText("Mondays 23:00–00:00 · live 0 of 2 weeks")).toBeInTheDocument();
});

test("the heading says how many weeks it covers", () => {
  renderApp(<LiveSchedule data={data} error={null} />);
  expect(screen.getByTestId("live-schedule")).toHaveTextContent(/usually live · last 2 weeks/i);
});

test("marks the current hour", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at(22, 20, 15)); // a Tuesday, 20:15
  renderApp(<LiveSchedule data={data} error={null} />);
  const marked = screen.getAllByTestId("schedule-cell").filter((c) => c.dataset.now === "true");
  expect(marked.map((c) => c.dataset.hour)).toEqual([String(TUE_20)]);
});

test("under two weeks it says so instead of drawing a sparse grid", () => {
  renderApp(<LiveSchedule data={{ ...data, since: at(9, 0) }} error={null} />);
  expect(screen.getByTestId("schedule-too-new"))
    .toHaveTextContent("Needs a couple of weeks of tracking");
  expect(screen.queryAllByTestId("schedule-cell")).toHaveLength(0);
  // No window worth naming yet, so the heading does not claim one.
  expect(screen.getByTestId("live-schedule")).not.toHaveTextContent(/last \d+ week/i);
});

test("loading and failure each say so", () => {
  const { rerender } = renderApp(<LiveSchedule data={null} error={null} />);
  expect(screen.getByTestId("schedule-loading")).toBeInTheDocument();
  rerender(
    <MantineProvider theme={theme} forceColorScheme="dark">
      <LiveSchedule data={null} error="boom" />
    </MantineProvider>,
  );
  expect(screen.getByTestId("schedule-error")).toHaveTextContent("Schedule unavailable");
});

/** jsdom reports inline colours as rgb(); compare in that form. */
function hexToRgb(hex: string): string {
  const [r, g, b] = hex.slice(1).match(/../g)!.map((x) => parseInt(x, 16));
  return `rgb(${r}, ${g}, ${b})`;
}
