import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { OwnedBadge } from "./OwnedBadge.js";
import { renderApp } from "../test-utils.js";

test("shows the game rather than the campaign name", () => {
  // The game is what a viewer recognises; campaign names mostly are not
  // ("DF Streamer Ladder FINNAL" is Delta Force).
  renderApp(
    <OwnedBadge label="DF Streamer Ladder FINNAL" game="Delta Force" testId="t" />,
  );
  expect(screen.getByTestId("t")).toHaveTextContent("Delta Force");
});

test("falls back to the campaign name when the game is unknown", () => {
  // The campaign has left the catalogue, so there is nothing to look up.
  renderApp(<OwnedBadge label="Rust Twitch Drops" game={null} testId="t" />);
  expect(screen.getByTestId("t")).toHaveTextContent("Rust Twitch Drops");
});

test("names the campaign and how to remove it in the tooltip", async () => {
  // The badge shows the game, so the campaign -- the thing you
  // unsubscribe from -- has to stay named somewhere.
  renderApp(
    <OwnedBadge label="DF Streamer Ladder FINNAL" game="Delta Force" testId="t" />,
  );
  await userEvent.hover(screen.getByTestId("t"));
  const tip = await screen.findByRole("tooltip");
  expect(tip).toHaveTextContent("DF Streamer Ladder FINNAL");
  expect(tip).toHaveTextContent("Auto-added for drops");
  expect(tip).toHaveTextContent("Unsubscribe on Drops");
});

test("carries the campaign on an accessible label", async () => {
  // A tooltip opens on hover, which a screen reader user never triggers.
  renderApp(<OwnedBadge label="Rust Twitch Drops" game="Rust" testId="t" />);
  expect(screen.getByTestId("t").getAttribute("aria-label"))
    .toMatch(/Rust Twitch Drops/);
});

test("renders nothing without a campaign label", () => {
  // A hand-added channel is not owned by anything.
  renderApp(<OwnedBadge label={null} game={null} testId="t" />);
  expect(screen.queryByTestId("t")).toBeNull();
});
