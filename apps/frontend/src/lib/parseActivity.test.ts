import { expect, test } from "vitest";
import { activityLabel, parseActivity } from "./parseActivity.js";

/**
 * What the miner actually sends, captured by running a PubSub-shaped
 * record through the vendor formatter with our own LoggerSettings -- not
 * hand-written. `less` is left at its default of False, so the
 * interpolated Streamer renders through its __repr__; `emoji` defaults to
 * True off Windows, so the line arrives with a rocket glyph in front.
 *
 * `python/tests/test_contract.py` pins this shape upstream, so a vendor
 * bump that reformats the line fails there rather than silently emptying
 * the amount off every card.
 */
const REAL =
  "🚀  +50 → Streamer(username=forsen, channel_id=22484632, channel_points=12.3k)"
  + " - Reason: CLAIM.";

test("reads the amount out of the line the miner really sends", () => {
  expect(parseActivity("GAIN_FOR_CLAIM", REAL)).toEqual({ earned: 50, label: "claim" });
});

test("reads past the emoji the formatter prepends", () => {
  // The regression this pins: an anchored /^\+/ matched nothing in
  // production while every un-prefixed fixture below still passed.
  expect(parseActivity("GAIN_FOR_CLAIM", REAL).earned).toBe(50);
  expect(parseActivity("GAIN_FOR_WATCH", "🚀  +10 → forsen - Reason: WATCH.").earned).toBe(10);
});

test("accepts the ASCII arrows the fixtures and Windows use", () => {
  // Production sends U+2192, but upstream rewrites it to "-->" when emoji
  // are off, and "->" is what the backend fixtures use.
  expect(parseActivity("GAIN_FOR_WATCH", "+10 -> forsen - Reason: WATCH."))
    .toEqual({ earned: 10, label: "watch" });
  expect(parseActivity("GAIN_FOR_WATCH", "+10 --> forsen - Reason: WATCH."))
    .toEqual({ earned: 10, label: "watch" });
});

test("never reads the millified balance as a number", () => {
  // "12.3k" is lossy display text. Only the leading exact figure is taken.
  expect(parseActivity("GAIN_FOR_CLAIM", REAL).earned).toBe(50);
});

test("keeps the label when there is no message at all", () => {
  // Rows stored before the doorbell forwarded messages.
  expect(parseActivity("GAIN_FOR_RAID", null)).toEqual({ earned: null, label: "raid" });
  expect(parseActivity("GAIN_FOR_RAID", undefined)).toEqual({ earned: null, label: "raid" });
});

test("drops the amount when the line is not a gain", () => {
  expect(parseActivity("STREAMER_ONLINE", "forsen is now streaming"))
    .toEqual({ earned: null, label: "streamer online" });
});

test("ignores an amount whose reason disagrees with the event type", () => {
  // The type is validated at the doorbell route; the message is free text.
  // A line that does not corroborate the type is one we do not understand.
  expect(parseActivity("GAIN_FOR_CLAIM", "+50 → forsen - Reason: WATCH.").earned).toBeNull();
});

test("does not report a zero gain as points earned", () => {
  expect(parseActivity("GAIN_FOR_WATCH", "+0 → forsen - Reason: WATCH.").earned).toBeNull();
});

test("survives a reformatted log line rather than losing the row", () => {
  // The miner is vendored code and can change its wording; the card must
  // fall back to the label, never render blank.
  expect(parseActivity("GAIN_FOR_CLAIM", "earned 50 points somehow"))
    .toEqual({ earned: null, label: "claim" });
});

test("labels an unrecognised event type rather than dropping it", () => {
  // The doorbell bounds the event name's shape, not its vocabulary.
  expect(activityLabel("DROP_CLAIM")).toBe("drop claim");
  expect(activityLabel("GAIN_FOR_RAID")).toBe("raid");
});
