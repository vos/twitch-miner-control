import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { BrandMark } from "./BrandMark.js";

test("is labelled for assistive tech", () => {
  render(<BrandMark />);
  expect(screen.getByRole("img", { name: /miner control/i })).toBeInTheDocument();
});

// The inline style, not the width/height attributes, is what actually
// sizes the image -- CSS wins over the presentational attributes, so
// asserting only the latter would stay green while the render broke.
test("scales to the requested size", () => {
  render(<BrandMark size={250} />);
  const img = screen.getByRole("img", { name: /miner control/i });
  expect(img).toHaveStyle({ width: "250px", height: "250px" });
});
