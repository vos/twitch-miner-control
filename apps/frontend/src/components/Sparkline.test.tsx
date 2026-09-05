import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Sparkline } from "./Sparkline.js";

test("renders nothing when there is no shape to draw", () => {
  const { container } = render(<Sparkline values={[]} />);
  expect(container.querySelector("svg")).toBeNull();
});

test("renders nothing for a single point", () => {
  const { container } = render(<Sparkline values={[5]} />);
  expect(container.querySelector("svg")).toBeNull();
});

test("draws a polyline through the values", () => {
  const { container } = render(<Sparkline values={[1, 2, 3]} />);
  expect(container.querySelector("polyline")).not.toBeNull();
});

test("draws a flat line when every value is identical", () => {
  // A zero-height range must not divide by zero and blank the card.
  const { container } = render(<Sparkline values={[7, 7, 7]} />);
  const points = container.querySelector("polyline")?.getAttribute("points") ?? "";
  const ys = points.split(" ").map((p) => Number(p.split(",")[1]));
  expect(new Set(ys).size).toBe(1);
  expect(ys.every(Number.isFinite)).toBe(true);
});

test("is hidden from assistive tech, since the numbers beside it carry the meaning", () => {
  const { container } = render(<Sparkline values={[1, 2, 3]} />);
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
});

test("draws an area fill under the line when asked", () => {
  const { container } = render(<Sparkline values={[1, 5, 3]} fill />);
  expect(container.querySelector("polygon")).toBeInTheDocument();
});

test("draws no fill by default", () => {
  const { container } = render(<Sparkline values={[1, 5, 3]} />);
  expect(container.querySelector("polygon")).not.toBeInTheDocument();
});

test("scales to its container instead of overflowing a narrow card", () => {
  // A fixed pixel width painted past the card edge on any card narrower
  // than the value passed in. The svg must be fluid.
  const { container } = render(<Sparkline values={[1, 5, 3]} fill />);
  const svg = container.querySelector("svg")!;
  expect(svg.getAttribute("width")).toBe("100%");
  expect(svg.getAttribute("viewBox")).toBeTruthy();
});

test("keeps the stroke inside the box so it is not clipped at the edges", () => {
  // Points plotted at exactly x=0 or y=height put half the stroke width
  // outside the svg, which reads as the chart drawing over the card.
  const { container } = render(<Sparkline values={[1, 5, 3]} />);
  const points = container.querySelector("polyline")!.getAttribute("points")!;
  const coords = points.split(" ").map((p) => p.split(",").map(Number));
  for (const [x, y] of coords) {
    expect(x).toBeGreaterThanOrEqual(1);
    expect(y).toBeGreaterThanOrEqual(1);
  }
});
