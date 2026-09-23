import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useGainFloat } from "./useGainFloat.js";

function track(value: number | null, animate = true) {
  return renderHook(
    (p: { value: number | null; animate: boolean }) => useGainFloat(p.value, p.animate),
    { initialProps: { value, animate } },
  );
}

test("nothing floats until the value changes", () => {
  const { result } = track(1000);
  expect(result.current[0]).toBeNull();
});

test("an animated increase floats the difference", () => {
  const { result, rerender } = track(1000);
  rerender({ value: 1050, animate: true });
  expect(result.current[0]).toMatchObject({ amount: 50 });
});

test("a decrease never floats", () => {
  const { result, rerender } = track(1000);
  rerender({ value: 900, animate: true });
  expect(result.current[0]).toBeNull();
});

test("a snapped increase does not float", () => {
  const { result, rerender } = track(1000);
  rerender({ value: 1050, animate: false });
  expect(result.current[0]).toBeNull();
});

test("a second gain replaces the first under a new id", () => {
  const { result, rerender } = track(1000);
  rerender({ value: 1050, animate: true });
  const first = result.current[0]!;
  rerender({ value: 1060, animate: true });
  expect(result.current[0]).toEqual({ amount: 10, id: first.id + 1 });
});

test("clearing removes it", () => {
  const { result, rerender } = track(1000);
  rerender({ value: 1050, animate: true });
  act(() => result.current[1]());
  expect(result.current[0]).toBeNull();
});

test("from or to null there is no gain to show", () => {
  const { result, rerender } = track(null);
  rerender({ value: 1000, animate: true });
  expect(result.current[0]).toBeNull();
});
