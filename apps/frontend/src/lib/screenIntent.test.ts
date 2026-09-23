import { expect, test } from "vitest";
import { stamped } from "./screenIntent.js";

test("no intent, no param", () => {
  expect(stamped(null, "campaign")).toBeNull();
});

test("an intent without that param gives null", () => {
  expect(stamped({ params: { prefill: "x" }, id: 3 }, "campaign")).toBeNull();
});

test("an intent with the param gives its value and the intent's id", () => {
  expect(stamped({ params: { campaign: "c1" }, id: 7 }, "campaign"))
    .toEqual({ value: "c1", id: 7 });
});
