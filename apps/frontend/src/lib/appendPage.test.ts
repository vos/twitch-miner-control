import { expect, test } from "vitest";
import { appendPage, type LivePage } from "./appendPage.js";

const page = (items: string[], total: number): LivePage<string> => ({ items, total });

test("appends only the items it does not already have", () => {
  const out = appendPage(page(["a", "b"], 2), page(["b", "c"], 3), 10);
  expect(out).toEqual({ items: ["a", "b", "c"], total: 3 });
});

test("a frame carrying nothing new is a no-op", () => {
  const current = page(["a", "b"], 2);
  expect(appendPage(current, page(["a", "b"], 2), 10)).toBe(current);
});

test("a frame from behind is ignored", () => {
  const current = page(["a", "b"], 2);
  expect(appendPage(current, page(["a"], 1), 10)).toBe(current);
});

test("a gap returns null so the caller reloads", () => {
  // The frame says 5 items exist and carries 1; items 3 and 4 went by
  // unseen, and nothing but a reload can recover them.
  expect(appendPage(page(["a", "b"], 2), page(["e"], 5), 10)).toBeNull();
});

test("the result is clipped to the cap, oldest first", () => {
  const out = appendPage(page(["a", "b"], 2), page(["c"], 3), 2);
  expect(out).toEqual({ items: ["b", "c"], total: 3 });
});

test("it works on objects, not just lines", () => {
  // The app event log streams through this same path; a second copy of
  // this logic is exactly what the generic exists to prevent.
  const a = { type: "a.thing" };
  const b = { type: "b.thing" };
  const out = appendPage({ items: [a], total: 1 }, { items: [b], total: 2 }, 10);
  expect(out).toEqual({ items: [a, b], total: 2 });
});
