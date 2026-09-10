import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { expect, test, vi } from "vitest";
import { StreamerSettingsModal } from "./StreamerSettingsModal.js";
import { renderApp } from "../test-utils.js";

const view = (over: Partial<ComponentProps<typeof StreamerSettingsModal>> = {}) => {
  const onChange = vi.fn();
  renderApp(
    <StreamerSettingsModal
      username="alpha" opened settings={{}} defaults={{}}
      onChange={onChange} onClose={() => {}} {...over}
    />,
  );
  return onChange;
};

test("names the streamer it is editing", () => {
  view();
  expect(screen.getByText(/alpha/)).toBeInTheDocument();
});

test("editing a field writes only that key", async () => {
  const onChange = view();
  await userEvent.click(screen.getByRole("switch", { name: "Override Watch streaks" }));
  expect(onChange).toHaveBeenCalledWith({ watchStreak: true });
});

test("clearing an override removes the key entirely", async () => {
  const onChange = view({ settings: { watchStreak: false } });
  await userEvent.click(screen.getByRole("switch", { name: "Override Watch streaks" }));
  expect(onChange).toHaveBeenCalledWith({});
});

test("inherits from the global defaults, not just upstream's", () => {
  view({ defaults: { watchStreak: false } });
  const badges = screen.getAllByTestId("field-state");
  expect(badges.some((b) => b.textContent?.includes("Inherit — Off"))).toBe(true);
});

test("bet fields live under the predictions tab and nest under bet", async () => {
  const onChange = view({ settings: { makePredictions: true } });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  await userEvent.click(screen.getByRole("switch", { name: "Override Strategy" }));
  expect(onChange).toHaveBeenCalledWith({
    makePredictions: true, bet: { strategy: "SMART" },
  });
});

test("predictions are disabled when the streamer does not bet", async () => {
  view({ settings: { makePredictions: false } });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  expect(screen.getByTestId("predictions-disabled-note")).toBeInTheDocument();
});

test("the filter condition's measure is editable, not fixed", async () => {
  const onChange = view({
    settings: {
      makePredictions: true,
      bet: { filterCondition: { by: "total_users", where: "LTE", value: 800 } },
    },
  });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  const measure = screen.getByRole("combobox", { name: "Measure" });
  await userEvent.click(measure);
  // Scoped to this combobox's own listbox: the Strategy and Delay mode
  // Selects are on the same panel and Mantine keeps their portalled
  // options in the DOM, so an unscoped count collects all of them. The
  // dropdown wrapper is display:none, hence hidden:true throughout.
  const listbox = document.getElementById(measure.getAttribute("aria-controls") ?? "");
  expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(6);
  await userEvent.click(screen.getByRole("option", { name: "Odds", hidden: true }));
  expect(onChange).toHaveBeenCalledWith({
    makePredictions: true,
    bet: { filterCondition: { by: "odds", where: "LTE", value: 800 } },
  });
});

test("the filter condition's comparison is editable", async () => {
  const onChange = view({
    settings: {
      makePredictions: true,
      bet: { filterCondition: { by: "total_users", where: "LTE", value: 800 } },
    },
  });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  await userEvent.click(screen.getByRole("combobox", { name: "Comparison" }));
  await userEvent.click(
    screen.getByRole("option", { name: "is at least", hidden: true }));
  expect(onChange).toHaveBeenCalledWith({
    makePredictions: true,
    bet: { filterCondition: { by: "total_users", where: "GTE", value: 800 } },
  });
});

test("the filter condition's value is editable", async () => {
  const onChange = view({
    settings: {
      makePredictions: true,
      bet: { filterCondition: { by: "total_users", where: "LTE", value: 800 } },
    },
  });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  const value = screen.getByRole("textbox", { name: "Value" });
  await userEvent.clear(value);
  await userEvent.type(value, "250");
  expect(onChange).toHaveBeenLastCalledWith({
    makePredictions: true,
    bet: { filterCondition: { by: "total_users", where: "LTE", value: 250 } },
  });
});

test("the filter controls are absent until the condition is enabled", async () => {
  view({ settings: { makePredictions: true } });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  expect(screen.queryByRole("combobox", { name: "Measure" })).not.toBeInTheDocument();
});

test("a filter condition is only written once enabled", async () => {
  const onChange = view({ settings: { makePredictions: true } });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  await userEvent.click(screen.getByRole("switch", { name: /only bet when/i }));
  expect(onChange).toHaveBeenCalledWith({
    makePredictions: true,
    bet: { filterCondition: { by: "total_users", where: "LTE", value: 800 } },
  });
});
