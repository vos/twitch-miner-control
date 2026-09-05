import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useLocalToggle } from "./useLocalToggle.js";

afterEach(() => localStorage.clear());

test("starts from the given default when nothing is stored", () => {
  const { result } = renderHook(() => useLocalToggle("feed", true));
  expect(result.current[0]).toBe(true);
});

test("remembers a toggle across remounts", () => {
  const first = renderHook(() => useLocalToggle("feed", true));
  act(() => first.result.current[1]());
  first.unmount();

  const second = renderHook(() => useLocalToggle("feed", true));
  expect(second.result.current[0]).toBe(false);
});

test("survives storage being unavailable", () => {
  // Private-mode browsers throw on access rather than returning null.
  const original = Storage.prototype.getItem;
  Storage.prototype.getItem = () => { throw new Error("denied"); };
  try {
    const { result } = renderHook(() => useLocalToggle("feed", true));
    expect(result.current[0]).toBe(true);
  } finally {
    Storage.prototype.getItem = original;
  }
});
