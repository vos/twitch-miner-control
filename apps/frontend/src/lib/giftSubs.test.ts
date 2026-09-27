import { expect, test } from "vitest";
import { giftEnds, giftFrom, giftTitle } from "./giftSubs.js";
import type { GiftSub } from "../api/useLiveState.js";

const DAY = 86_400_000;
// Local time: the container runs Europe/Berlin and vitest pins no TZ.
const now = new Date(2026, 8, 27, 12, 0).getTime();

const gift = (over: Partial<GiftSub> = {}): GiftSub => ({
  id: "g1", tier: 1, product: "KDRkitten Sub",
  gifter: { login: "badbeard95", displayName: "BadBeard95" },
  target: { channelId: "42", login: "kdrkitten", displayName: "KDRkitten" },
  endsAt: new Date(2026, 9, 6, 16, 17).getTime(),
  ...over,
});

test("titles a channel gift by its tier", () => {
  expect(giftTitle(gift({ tier: 3 }))).toBe("Tier 3 gift sub");
});

test("titles a gift without a numbered tier by its product", () => {
  // Turbo's tier is "Custom", which means nothing to a reader.
  expect(giftTitle(gift({ tier: "Custom", product: "Twitch Turbo", target: null })))
    .toBe("Twitch Turbo gift");
});

test("names the gifter", () => {
  expect(giftFrom(gift())).toBe("BadBeard95");
});

test("names an anonymous gifter as such", () => {
  expect(giftFrom(gift({ gifter: null }))).toBeNull();
});

test("gives the end as a date and a time left", () => {
  const out = giftEnds(gift(), now);
  expect(out).toMatch(/^Ends /);
  expect(out).toContain("16:17");
  expect(out).toContain("in 9d");
});

test("uses hours in the last two days", () => {
  expect(giftEnds(gift({ endsAt: now + 5 * 3_600_000 }), now)).toContain("in 5h");
});

test("says ended rather than a negative span once past", () => {
  expect(giftEnds(gift({ endsAt: now - DAY }), now)).toBe("Ended");
});
