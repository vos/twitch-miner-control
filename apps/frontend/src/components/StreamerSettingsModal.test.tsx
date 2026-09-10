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

test("a filter condition is only written once enabled", async () => {
  const onChange = view({ settings: { makePredictions: true } });
  await userEvent.click(screen.getByRole("tab", { name: /predictions/i }));
  await userEvent.click(screen.getByRole("switch", { name: /only bet when/i }));
  expect(onChange).toHaveBeenCalledWith({
    makePredictions: true,
    bet: { filterCondition: { by: "total_users", where: "LTE", value: 800 } },
  });
});
