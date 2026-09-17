import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { DropRow, type ResolvedDrop } from "./DropRow.js";
import { renderApp } from "../test-utils.js";

const drop = (over: Partial<ResolvedDrop> = {}): ResolvedDrop => ({
  id: "d1",
  name: "Crate",
  benefits: ["Crate"],
  requiredMinutes: 60,
  minutes: 30,
  status: "in-progress",
  ...over,
});

test("shows minutes watched against the requirement", () => {
  renderApp(<DropRow drop={drop()} />);
  expect(screen.getByTestId("drop-progress").textContent).toMatch(/30\/60m/);
});

test("an in-progress drop renders a bar", () => {
  renderApp(<DropRow drop={drop()} />);
  expect(screen.getByTestId("drop-bar")).toBeTruthy();
});

test("a claimed drop says so and shows no bar", () => {
  renderApp(<DropRow drop={drop({ status: "claimed", minutes: 60 })} />);
  expect(screen.getByTestId("drop-state").textContent).toMatch(/claimed/i);
  expect(screen.queryByTestId("drop-bar")).toBeNull();
});

test("a claimable drop is called out as ready", () => {
  renderApp(<DropRow drop={drop({ status: "claimable", minutes: 60 })} />);
  expect(screen.getByTestId("drop-state").textContent).toMatch(/ready/i);
});

test("a sub-gated drop explains why it cannot be earned", () => {
  // Without the reason it reads as a bug rather than a rule: "collect
  // all drops" will never complete for this one and the user needs to
  // know that is by design.
  renderApp(<DropRow drop={drop({ status: "unobtainable" })} />);
  expect(screen.getByTestId("drop-state").textContent).toMatch(/sub/i);
  expect(screen.queryByTestId("drop-bar")).toBeNull();
});

test("an unknown drop shows an em-dash, never a zero bar", () => {
  // "Nothing earned" and "nothing known" are different claims -- the
  // same distinction Gain draws for balances.
  renderApp(<DropRow drop={drop({ status: "unknown", minutes: 0 })} />);
  expect(screen.getByTestId("drop-progress").textContent).toContain("—");
  expect(screen.queryByTestId("drop-bar")).toBeNull();
});

test("a not-started drop shows the requirement without progress", () => {
  renderApp(<DropRow drop={drop({ status: "not-started", minutes: 0 })} />);
  expect(screen.getByTestId("drop-progress").textContent).toMatch(/60m/);
  expect(screen.queryByTestId("drop-bar")).toBeNull();
});

test("the drop's name and what it awards are both shown", () => {
  renderApp(
    <DropRow drop={drop({ name: "Weapon Charm", benefits: ["Charm", "Skin"] })} />,
  );
  expect(screen.getByText("Weapon Charm")).toBeTruthy();
  expect(screen.getByTestId("drop-benefits").textContent).toBe("Charm, Skin");
});

test("a drop awarding nothing named omits the benefits line", () => {
  renderApp(<DropRow drop={drop({ benefits: [] })} />);
  expect(screen.queryByTestId("drop-benefits")).toBeNull();
});
