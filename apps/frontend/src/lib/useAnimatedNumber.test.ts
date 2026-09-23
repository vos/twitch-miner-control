import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { easeOut, useAnimatedNumber } from "./useAnimatedNumber.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => vi.useRealTimers());

function track(value: number | null, animate: boolean) {
  return renderHook(
    (p: { value: number | null; animate: boolean }) => useAnimatedNumber(p.value, p.animate),
    { initialProps: { value, animate } },
  );
}

test("easing starts at 0, ends at 1 and front-loads the distance", () => {
  expect(easeOut(0)).toBe(0);
  expect(easeOut(1)).toBe(1);
  expect(easeOut(0.5)).toBeGreaterThan(0.5);
});

test("without animation a change lands at once", () => {
  const { result, rerender } = track(1000, false);
  rerender({ value: 2000, animate: false });
  expect(result.current).toBe(2000);
});

test("with animation it rolls from the old value to the new one", () => {
  const { result, rerender } = track(1000, true);
  rerender({ value: 2000, animate: true });
  expect(result.current).toBe(1000);

  act(() => vi.advanceTimersByTime(300));
  expect(result.current).toBeGreaterThan(1000);
  expect(result.current).toBeLessThan(2000);

  act(() => vi.advanceTimersByTime(400));
  expect(result.current).toBe(2000);
});

test("a snapped change mid-roll lands at once", () => {
  const { result, rerender } = track(1000, true);
  rerender({ value: 2000, animate: true });
  act(() => vi.advanceTimersByTime(200));
  rerender({ value: 3000, animate: false });
  expect(result.current).toBe(3000);
});

test("a second animated change continues from where the first had got to", () => {
  const { result, rerender } = track(1000, true);
  rerender({ value: 2000, animate: true });
  act(() => vi.advanceTimersByTime(200));
  const midway = result.current!;
  rerender({ value: 3000, animate: true });
  expect(result.current).toBe(midway);
  act(() => vi.advanceTimersByTime(700));
  expect(result.current).toBe(3000);
});

test("to or from null there is nothing to roll between", () => {
  const { result, rerender } = track(null, true);
  rerender({ value: 500, animate: true });
  expect(result.current).toBe(500);
  rerender({ value: null, animate: true });
  expect(result.current).toBeNull();
});
