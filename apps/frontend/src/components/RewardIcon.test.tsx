import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { RewardIcon } from "./RewardIcon.js";
import { renderApp } from "../test-utils.js";

test("shows the reward artwork when there is some", () => {
  renderApp(<RewardIcon name="Crate" imageUrl="https://cdn/crate.png" />);
  const icon = screen.getByTestId("reward-icon") as HTMLImageElement;
  expect(icon.src).toBe("https://cdn/crate.png");
});

test("falls back to a glyph rather than a broken image", () => {
  // The source omits imageAssetUrl on some benefits; an <img> with no
  // src still draws the browser's own missing-image chrome.
  renderApp(<RewardIcon name="Crate" imageUrl={null} />);
  expect(screen.queryByTestId("reward-icon")).toBeNull();
  expect(screen.getByTestId("reward-placeholder")).toBeTruthy();
});

test("names the reward on hover, the strip having no room for labels", () => {
  renderApp(<RewardIcon name="Weapon Charm" imageUrl="https://cdn/c.png" />);
  expect(screen.getByTestId("reward-icon").getAttribute("title"))
    .toBe("Weapon Charm");
});

test("is decorative by default, a visible label naming it", () => {
  renderApp(<RewardIcon name="Crate" imageUrl="https://cdn/crate.png" />);
  expect(screen.getByTestId("reward-icon").getAttribute("alt")).toBe("");
});
