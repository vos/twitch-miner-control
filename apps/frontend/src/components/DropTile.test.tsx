import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { DropTile, type ResolvedDrop } from "./DropTile.js";
import { renderApp } from "../test-utils.js";

const drop = (over: Partial<ResolvedDrop> = {}): ResolvedDrop => ({
  id: "d1",
  name: "Crate",
  benefits: [{ name: "Crate", imageUrl: "https://cdn/crate.png" }],
  requiredMinutes: 60,
  minutes: 30,
  status: "in-progress",
  ...over,
});

test("shows minutes watched against the requirement", () => {
  renderApp(<DropTile drop={drop()} />);
  expect(screen.getByTestId("drop-progress").textContent).toMatch(/30\/60m/);
});

test("an in-progress drop renders a bar", () => {
  renderApp(<DropTile drop={drop()} />);
  expect(screen.getByTestId("drop-bar")).toBeTruthy();
});

test("a claimed drop says so and shows no bar", () => {
  renderApp(<DropTile drop={drop({ status: "claimed", minutes: 60 })} />);
  expect(screen.getByTestId("drop-state").textContent).toMatch(/claimed/i);
  expect(screen.queryByTestId("drop-bar")).toBeNull();
});

test("a claimable drop is called out as ready", () => {
  renderApp(<DropTile drop={drop({ status: "claimable", minutes: 60 })} />);
  expect(screen.getByTestId("drop-state").textContent).toMatch(/ready/i);
});

test("a sub-gated drop explains why it cannot be earned", () => {
  // Without the reason it reads as a bug rather than a rule: "collect
  // all drops" will never complete for this one and the user needs to
  // know that is by design.
  renderApp(<DropTile drop={drop({ status: "unobtainable" })} />);
  expect(screen.getByTestId("drop-state").textContent).toMatch(/sub/i);
  expect(screen.queryByTestId("drop-bar")).toBeNull();
});

test("an unknown drop shows an em-dash, never a zero bar", () => {
  // "Nothing earned" and "nothing known" are different claims -- the
  // same distinction Gain draws for balances.
  renderApp(<DropTile drop={drop({ status: "unknown", minutes: 0 })} />);
  expect(screen.getByTestId("drop-progress").textContent).toContain("—");
  expect(screen.queryByTestId("drop-bar")).toBeNull();
});

test("a not-started drop shows the requirement without progress", () => {
  renderApp(<DropTile drop={drop({ status: "not-started", minutes: 0 })} />);
  expect(screen.getByTestId("drop-progress").textContent).toMatch(/60m/);
  expect(screen.queryByTestId("drop-bar")).toBeNull();
});

test("the drop's name and what it awards are both shown", () => {
  renderApp(
    <DropTile drop={drop({ name: "Weapon Charm", benefits: [
      { name: "Charm", imageUrl: null },
      { name: "Skin", imageUrl: null },
    ] })} />,
  );
  expect(screen.getByText("Weapon Charm")).toBeTruthy();
  expect(screen.getByTestId("drop-benefits").textContent).toBe("Charm, Skin");
});

test("a drop awarding nothing named omits the benefits line", () => {
  renderApp(<DropTile drop={drop({ benefits: [] })} />);
  expect(screen.queryByTestId("drop-benefits")).toBeNull();
});

test("a benefit that only repeats the drop's name is not shown twice", () => {
  // "Hazmat Suit / Hazmat Suit" reads as a rendering fault rather than
  // as detail about the reward.
  renderApp(
    <DropTile drop={drop({ name: "Hazmat Suit", benefits: [{ name: "Hazmat Suit", imageUrl: null }] })} />,
  );
  expect(screen.queryByTestId("drop-benefits")).toBeNull();
});

test("a benefit differing from the name is still shown", () => {
  renderApp(
    <DropTile drop={drop({ name: "Starter Pack", benefits: [{ name: "Hazmat Suit", imageUrl: null }] })} />,
  );
  expect(screen.getByTestId("drop-benefits").textContent).toBe("Hazmat Suit");
});

test("shows the reward's artwork on the tile", () => {
  renderApp(<DropTile drop={drop()} />);
  const icon = screen.getByTestId("reward-icon") as HTMLImageElement;
  expect(icon.src).toBe("https://cdn/crate.png");
});

test("uses the first reward as the tile's image", () => {
  // A drop granting several awards them together -- there is no main
  // one to pick, and the tile holds a single image.
  renderApp(<DropTile drop={drop({
    benefits: [
      { name: "Charm", imageUrl: "https://cdn/charm.png" },
      { name: "Skin", imageUrl: "https://cdn/skin.png" },
    ],
  })} />);
  expect((screen.getByTestId("reward-icon") as HTMLImageElement).src)
    .toBe("https://cdn/charm.png");
});

test("falls back to a glyph for a reward with no artwork", () => {
  renderApp(<DropTile drop={drop({
    benefits: [{ name: "Crate", imageUrl: null }],
  })} />);
  expect(screen.getByTestId("reward-placeholder")).toBeTruthy();
});
