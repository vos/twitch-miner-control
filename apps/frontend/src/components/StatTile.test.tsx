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

test("renders a unit glyph beside the figure when given one", () => {
  // The row mixes points and channel counts; the glyph is what says
  // which a given figure is without reading the label.
  renderApp(
    <StatTile label="Total points" value="124,530" testId="total-points"
      icon={<svg data-testid="glyph" aria-hidden />} />,
  );
  expect(screen.getByTestId("total-points")).toContainElement(screen.getByTestId("glyph"));
});

test("keeps the glyph out of the figure's text", () => {
  // The label already names the figure for assistive tech, so the icon
  // must not add to what is read out or matched against.
  renderApp(
    <StatTile label="Total points" value="124,530" testId="total-points"
      icon={<svg data-testid="glyph" aria-hidden />} />,
  );
  expect(screen.getByTestId("total-points")).toHaveTextContent(/^124,530$/);
});

test("renders no glyph when none was given", () => {
  // The 24h gain tile deliberately carries none.
  const { container } = renderApp(
    <StatTile label="24h gain" value="+4,280" testId="stat-24h" />,
  );
  expect(container.querySelector("svg")).toBeNull();
});

test("shows the glyph while the figure is still loading", () => {
  // The icon is known up front, so only the number waits -- and keeping
  // it out of the skeleton stops the tile shifting when the figure lands.
  renderApp(
    <StatTile label="Total points" value="" loading testId="total-points"
      icon={<svg data-testid="glyph" aria-hidden />} />,
  );
  expect(screen.getByTestId("glyph")).toBeInTheDocument();
  expect(screen.getByTestId("total-points-loading")).toBeInTheDocument();
});

test("keeps a long figure on one line with its glyph", () => {
  // A wrapping value row let a seven-figure total wrap away from its own
  // coin, leaving the glyph stranded alone on the line above.
  renderApp(
    <StatTile label="Total points" value="1,234,567" testId="total-points"
      icon={<svg data-testid="glyph" aria-hidden />} />,
  );
  const figure = screen.getByTestId("glyph").parentElement;
  expect(figure).toHaveTextContent("1,234,567");
});
