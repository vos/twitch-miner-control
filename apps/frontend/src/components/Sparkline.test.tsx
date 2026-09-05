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
