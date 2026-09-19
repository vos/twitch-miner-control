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

test("every benefit is listed with its own icon and name", () => {
  // The whole point of the gallery: a drop awarding twelve items showed
  // one icon and a clamped comma list, so eleven of its rewards had
  // artwork in the data that was never drawn anywhere in the UI.
  renderApp(
    <DropTile drop={drop({ name: "Starter Pack", benefits: [
      { name: "Charm", imageUrl: "https://cdn/charm.png" },
      { name: "Skin", imageUrl: "https://cdn/skin.png" },
      { name: "Gem", imageUrl: "https://cdn/gem.png" },
    ] })} />,
  );
  expect(screen.getByText("Starter Pack")).toBeTruthy();
  const rows = screen.getAllByTestId("drop-benefit");
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.textContent)).toEqual(["Charm", "Skin", "Gem"]);
  expect(screen.getAllByTestId("reward-icon").map((i) => (i as HTMLImageElement).src))
    .toEqual(["https://cdn/charm.png", "https://cdn/skin.png", "https://cdn/gem.png"]);
});

test("a benefit name is shown in full rather than truncated", () => {
  // The old single line clamped to one row, so a long reward name was
  // cut off mid-word and the ones after it were invisible.
  renderApp(
    <DropTile drop={drop({ name: "Bundle", benefits: [
      { name: "Elite Hero Badge S*5", imageUrl: null },
      { name: "Stamina Recovery I*5", imageUrl: null },
    ] })} />,
  );
  expect(screen.getByText("Elite Hero Badge S*5")).toBeTruthy();
  expect(screen.getByText("Stamina Recovery I*5")).toBeTruthy();
});

test("a drop awarding nothing named prints no benefit labels", () => {
  // It still gets one row, standing for the drop itself, so the tile is
  // not imageless -- but there is no name to print beside it.
  renderApp(<DropTile drop={drop({ name: "Mystery", benefits: [] })} />);
  expect(screen.getAllByTestId("drop-benefit")).toHaveLength(1);
  expect(screen.getAllByText("Mystery")).toHaveLength(1);
});

test("a drop awarding nothing named still shows artwork for itself", () => {
  // The tile cannot be imageless: it falls back to representing the
  // drop, which is what the collapsed strip does for the same case.
  renderApp(<DropTile drop={drop({ benefits: [] })} />);
  expect(screen.getByTestId("reward-placeholder")).toBeTruthy();
});

test("a benefit repeating the drop's name is not printed twice", () => {
  // "Hazmat Suit / Hazmat Suit" reads as a rendering fault. The icon
  // stays -- it is the tile's artwork -- but the label goes.
  renderApp(
    <DropTile drop={drop({
      name: "Hazmat Suit",
      benefits: [{ name: "Hazmat Suit", imageUrl: "https://cdn/suit.png" }],
    })} />,
  );
  expect(screen.getAllByText("Hazmat Suit")).toHaveLength(1);
  expect(screen.getByTestId("reward-icon")).toBeTruthy();
});

test("falls back to a glyph for a benefit with no artwork", () => {
  renderApp(<DropTile drop={drop({
    name: "Bundle",
    benefits: [{ name: "Crate", imageUrl: null }],
  })} />);
  expect(screen.getByTestId("reward-placeholder")).toBeTruthy();
});

test("a drop awarding one thing keeps the big icon beside its name", () => {
  // The common case, and it reads best as a single line. Stacking one
  // reward into a list orphans the name on a row of its own and shrinks
  // the art -- which is what the multi-reward layout is for.
  renderApp(<DropTile drop={drop({
    name: "Credit*20000",
    benefits: [{ name: "Credit*20000", imageUrl: "https://cdn/credit.png" }],
  })} />);
  // Mantine renders the size as rem: 40px is 2.5rem.
  const icon = screen.getByTestId("reward-icon") as HTMLElement;
  expect(icon.style.width).toContain("2.5rem");
  // One row, and no stacked list wrapping it.
  expect(screen.getAllByTestId("drop-benefit")).toHaveLength(1);
  expect(screen.queryByTestId("drop-benefit-list")).toBeNull();
});

test("a drop awarding several switches to the stacked list", () => {
  renderApp(<DropTile drop={drop({ name: "Bundle", benefits: [
    { name: "Charm", imageUrl: "https://cdn/charm.png" },
    { name: "Skin", imageUrl: "https://cdn/skin.png" },
  ] })} />);
  expect(screen.getByTestId("drop-benefit-list")).toBeTruthy();
  // 24px is 1.5rem -- the smaller art the stacked list uses.
  for (const i of screen.getAllByTestId("reward-icon")) {
    expect((i as HTMLElement).style.width).toContain("1.5rem");
  }
});
