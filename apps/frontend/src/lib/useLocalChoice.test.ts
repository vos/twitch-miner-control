import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { useLocalChoice } from "./useLocalChoice.js";

const OPTIONS = ["default", "name", "gain"] as const;

afterEach(() => localStorage.clear());

test("starts from the given default when nothing is stored", () => {
  const { result } = renderHook(() => useLocalChoice("sort", "default", OPTIONS));
  expect(result.current[0]).toBe("default");
});

test("remembers a choice across remounts", () => {
  const first = renderHook(() => useLocalChoice("sort", "default", OPTIONS));
  act(() => first.result.current[1]("gain"));
  first.unmount();

  const second = renderHook(() => useLocalChoice("sort", "default", OPTIONS));
  expect(second.result.current[0]).toBe("gain");
});

// A value from an older build -- or a hand-edited one -- must not reach the
// comparator: the control would render a blank selection and the grid would
// sit in an order no option describes.
test("falls back to the default when the stored value is not an option", () => {
  localStorage.setItem("sort", "nonsense");
  const { result } = renderHook(() => useLocalChoice("sort", "default", OPTIONS));
  expect(result.current[0]).toBe("default");
});

test("survives storage being unavailable", () => {
  // Private-mode browsers throw on access rather than returning null.
  const original = Storage.prototype.getItem;
  Storage.prototype.getItem = () => { throw new Error("denied"); };
  try {
    const { result } = renderHook(() => useLocalChoice("sort", "name", OPTIONS));
    expect(result.current[0]).toBe("name");
  } finally {
    Storage.prototype.getItem = original;
  }
});

test("keeps the new choice when it cannot be persisted", () => {
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = () => { throw new Error("quota"); };
  try {
    const { result } = renderHook(() => useLocalChoice("sort", "default", OPTIONS));
    act(() => result.current[1]("name"));
    expect(result.current[0]).toBe("name");
  } finally {
    Storage.prototype.setItem = original;
  }
});
