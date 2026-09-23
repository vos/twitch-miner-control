import { renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { StateSnapshot } from "../api/useLiveState.js";
import { canAnimate, useFrameMotion } from "./balanceMotion.js";

const live = { pending: false, visible: true };

test("the first frame never animates", () => {
  expect(canAnimate(null, live, false)).toBe(false);
});

test("two complete, visible frames animate", () => {
  expect(canAnimate(live, live, false)).toBe(true);
});

test("a pending frame on either side snaps", () => {
  // The SQLite frame's jump to Twitch's figure is a correction, not a gain.
  expect(canAnimate({ pending: true, visible: true }, live, false)).toBe(false);
  expect(canAnimate(live, { pending: true, visible: true }, false)).toBe(false);
});

test("a frame seen while hidden, on either side, snaps", () => {
  expect(canAnimate({ pending: false, visible: false }, live, false)).toBe(false);
  expect(canAnimate(live, { pending: false, visible: false }, false)).toBe(false);
});

test("reduced motion always snaps", () => {
  expect(canAnimate(live, live, true)).toBe(false);
});

// --- useFrameMotion: the same rules, applied to a sequence of snapshots ---

const frame = (pending = false): StateSnapshot =>
  ({ streamers: [], lastUpdated: 1, stale: false, error: null, pending });

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true, get: () => state,
  });
}

afterEach(() => setVisibility("visible"));

function track(reduced = false) {
  return renderHook(
    ({ snapshot }: { snapshot: StateSnapshot | null }) => useFrameMotion(snapshot, reduced),
    { initialProps: { snapshot: null as StateSnapshot | null } },
  );
}

test("no snapshot, then the first one: neither animates", () => {
  const { result, rerender } = track();
  expect(result.current).toBe(false);
  rerender({ snapshot: frame() });
  expect(result.current).toBe(false);
});

test("the second complete frame animates, and re-renders keep the decision", () => {
  const { result, rerender } = track();
  rerender({ snapshot: frame() });
  const second = frame();
  rerender({ snapshot: second });
  expect(result.current).toBe(true);
  rerender({ snapshot: second });
  expect(result.current).toBe(true);
});

test("the frame after a pending one snaps; the one after that animates", () => {
  const { result, rerender } = track();
  rerender({ snapshot: frame(true) });
  rerender({ snapshot: frame() });
  expect(result.current).toBe(false);
  rerender({ snapshot: frame() });
  expect(result.current).toBe(true);
});

test("coming back to the tab snaps the first frame after", () => {
  const { result, rerender } = track();
  rerender({ snapshot: frame() });
  setVisibility("hidden");
  rerender({ snapshot: frame() });
  expect(result.current).toBe(false);
  setVisibility("visible");
  rerender({ snapshot: frame() });
  expect(result.current).toBe(false);
  rerender({ snapshot: frame() });
  expect(result.current).toBe(true);
});

test("reduced motion never animates", () => {
  const { result, rerender } = track(true);
  rerender({ snapshot: frame() });
  rerender({ snapshot: frame() });
  expect(result.current).toBe(false);
});
