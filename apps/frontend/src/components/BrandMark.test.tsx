import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { BrandMark } from "./BrandMark.js";

test("is labelled for assistive tech", () => {
  render(<BrandMark />);
  expect(screen.getByRole("img", { name: /miner control/i })).toBeInTheDocument();
});

test("scales to the requested size", () => {
  const { container } = render(<BrandMark size={96} />);
  const svg = container.querySelector("svg");
  expect(svg).toHaveAttribute("width", "96");
  expect(svg).toHaveAttribute("height", "96");
});
