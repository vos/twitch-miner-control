import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RollingNumber } from "./RollingNumber.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => vi.useRealTimers());

const ui = (value: number | null, animate: boolean) => (
  <MantineProvider>
    <span data-testid="n"><RollingNumber value={value} animate={animate} /></span>
  </MantineProvider>
);

test("at rest it is the formatted figure and nothing else", () => {
  render(ui(1234567, false));
  // Exact: other tests match balances with anchored patterns.
  expect(screen.getByTestId("n").textContent).toBe("1,234,567");
});

test("null reads as a dash", () => {
  render(ui(null, true));
  expect(screen.getByTestId("n").textContent).toBe("—");
});

test("while rolling, the moving digits are hidden and the final figure is not", () => {
  const { rerender } = render(ui(1000, true));
  rerender(ui(2000, true));
  act(() => vi.advanceTimersByTime(200));

  const moving = screen.getByTestId("n").querySelector("[aria-hidden]");
  expect(moving).not.toBeNull();
  expect(moving!.textContent).not.toBe("2,000");
  // A screen reader hears only where the balance is going.
  expect(screen.getByText("2,000")).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(600));
  expect(screen.getByTestId("n").textContent).toBe("2,000");
});
