import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { NavItem } from "./NavItem.js";

test("marks the active row for assistive tech, not just visually", () => {
  renderApp(<NavItem icon={null} label="Dashboard" active onClick={() => {}} />);
  expect(screen.getByRole("button", { name: /dashboard/i }))
    .toHaveAttribute("aria-current", "page");
});

test("leaves an inactive row unmarked", () => {
  renderApp(<NavItem icon={null} label="Logs" active={false} onClick={() => {}} />);
  expect(screen.getByRole("button", { name: /logs/i }))
    .not.toHaveAttribute("aria-current");
});

test("navigates when clicked", async () => {
  const onClick = vi.fn();
  renderApp(<NavItem icon={null} label="Settings" active={false} onClick={onClick} />);
  await userEvent.click(screen.getByRole("button", { name: /settings/i }));
  expect(onClick).toHaveBeenCalledOnce();
});

test("renders a badge beside the label", () => {
  renderApp(
    <NavItem icon={null} label="Streamers" active={false} onClick={() => {}} badge={<span>3</span>} />,
  );
  expect(screen.getByRole("button", { name: /streamers/i })).toHaveTextContent("3");
});
