import { expect, test } from "vitest";
import { campaignQueue } from "./queue.js";
import type { Subscription } from "../config/schema.js";
import type { Campaign } from "../state/campaignCatalogue.js";

const sub = (id: string, over: Partial<Subscription> = {}): Subscription => ({
  id, targetId: id, label: id, poolSize: 3, rank: 0, ...over,
});
const campaign = (id: string, startsAt: number | null = 1): Campaign => ({
  id, name: id, game: null, startsAt, endsAt: null, drops: [],
});

test("the first campaign subscription is active and the rest wait in order", () => {
  const cs = [campaign("a"), campaign("b"), campaign("c")];
  const q = campaignQueue(
    [sub("a"), sub("b"), sub("c")], (s) => cs.find((c) => c.id === s.targetId), 10,
  );
  expect(Object.fromEntries(q)).toEqual({
    a: { state: "active", position: 0 },
    b: { state: "waiting", position: 1 },
    c: { state: "waiting", position: 2 },
  });
});

test("a scheduled campaign is passed over rather than holding the slot", () => {
  const cs = [campaign("a", 50), campaign("b")];
  const q = campaignQueue([sub("a"), sub("b")], (s) => cs.find((c) => c.id === s.targetId), 10);
  expect(q.get("a")).toEqual({ state: "scheduled", position: 1 });
  expect(q.get("b")).toEqual({ state: "active", position: 0 });
});

test("a subscription leaving on this pass hands the slot to the next", () => {
  const q = campaignQueue([sub("a"), sub("b")], () => undefined, 10, new Set(["a"]));
  expect(q.has("a")).toBe(false);
  expect(q.get("b")?.state).toBe("active");
});

test("a campaign missing from the catalogue can still be active", () => {
  const q = campaignQueue([sub("a")], () => undefined, 10);
  expect(q.get("a")?.state).toBe("active");
});

