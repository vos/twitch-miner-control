import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { SettingsFieldRow } from "./SettingsFieldRow.js";
import { BET_FIELDS, SETTINGS_FIELDS } from "../lib/settingsFields.js";
import { renderApp } from "../test-utils.js";

const field = (key: string) =>
  [...SETTINGS_FIELDS, ...BET_FIELDS].find((f) => f.key === key)!;

test("shows the inherited value while the field is unset", () => {
  renderApp(
    <SettingsFieldRow
      field={field("watchStreak")} value={undefined} inheritedValue={true}
      canInherit onChange={() => {}}
    />,
  );
  expect(screen.getByTestId("field-state")).toHaveTextContent("Inherit");
  expect(screen.getByTestId("field-state")).toHaveTextContent("On");
});

test("overriding emits the inherited value, so nothing changes by surprise", async () => {
  const onChange = vi.fn();
  renderApp(
    <SettingsFieldRow
      field={field("watchStreak")} value={undefined} inheritedValue={true}
      canInherit onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: /override/i }));
  expect(onChange).toHaveBeenCalledWith(true);
});

test("resetting clears the key rather than writing a value", async () => {
  const onChange = vi.fn();
  renderApp(
    <SettingsFieldRow
      field={field("watchStreak")} value={false} inheritedValue={true}
      canInherit onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: /override/i }));
  expect(onChange).toHaveBeenCalledWith(undefined);
});

test("an overridden false is not mistaken for unset", () => {
  renderApp(
    <SettingsFieldRow
      field={field("watchStreak")} value={false} inheritedValue={true}
      canInherit onChange={() => {}}
    />,
  );
  expect(screen.getByTestId("field-state")).toHaveTextContent("Overridden");
  expect(screen.getByRole("switch", { name: "Watch streaks" })).not.toBeChecked();
});

test("an enum field offers every option and reports the chosen one", async () => {
  const onChange = vi.fn();
  renderApp(
    <SettingsFieldRow
      field={field("chat")} value="ONLINE" canInherit={false} onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Chat presence" }));
  // Mantine portals the dropdown into a display:none wrapper, so Testing
  // Library filters the options out unless hidden:true.
  expect(screen.getAllByRole("option", { hidden: true })).toHaveLength(4);
  await userEvent.click(screen.getByRole("option", { name: "Never", hidden: true }));
  expect(onChange).toHaveBeenCalledWith("NEVER");
});

test("an optional number switches between off and a value", async () => {
  const onChange = vi.fn();
  renderApp(
    <SettingsFieldRow
      field={field("pointsLimit")} value={false} canInherit={false} onChange={onChange}
    />,
  );
  expect(screen.queryByRole("textbox", { name: "Points limit" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("switch", { name: /points limit/i }));
  expect(onChange).toHaveBeenCalledWith(1);
});

test("falls back to the upstream default when it cannot inherit", () => {
  renderApp(
    <SettingsFieldRow
      field={field("communityGoals")} value={undefined} canInherit={false}
      onChange={() => {}}
    />,
  );
  // The control carries the value; no badge restates it. A badge here would
  // only repeat what the switch beside it already shows -- it earns its
  // place solely on inherit-capable rows, where it says whether the value
  // is the field's own or the default's.
  expect(screen.queryByTestId("field-state")).not.toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Community goals" })).not.toBeChecked();
});

test("a disabled row cannot be edited", async () => {
  const onChange = vi.fn();
  renderApp(
    <SettingsFieldRow
      field={field("stealthMode")} value={true} canInherit={false} disabled
      onChange={onChange}
    />,
  );
  await userEvent.click(screen.getByRole("switch", { name: "Stealth mode" }));
  expect(onChange).not.toHaveBeenCalled();
});
