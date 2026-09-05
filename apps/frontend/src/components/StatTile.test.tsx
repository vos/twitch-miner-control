import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderApp } from "../test-utils.js";
import { StatTile } from "./StatTile.js";

test("shows its label and value", () => {
  renderApp(<StatTile label="Total points" value="124,530" />);
  expect(screen.getByText("Total points")).toBeInTheDocument();
  expect(screen.getByText("124,530")).toBeInTheDocument();
});

test("exposes a testid for the value when asked", () => {
  renderApp(<StatTile label="Total points" value="—" testId="total-points" />);
  expect(screen.getByTestId("total-points")).toHaveTextContent("—");
});
