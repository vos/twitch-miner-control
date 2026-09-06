import { expect, test } from "vitest";
import { attribute } from "./attribute.js";

test("attributes a message naming one roster streamer", () => {
  expect(attribute("+50 -> forsen", ["forsen", "alpha"])).toBe("forsen");
});

test("matches case-insensitively", () => {
  expect(attribute("+50 -> Forsen", ["forsen"])).toBe("forsen");
});

test("returns the roster's spelling, not the message's", () => {
  // The result is used as a database key, so it has to match the roster
  // exactly rather than however the miner happened to capitalise it.
  expect(attribute("+50 -> FORSEN", ["forsen"])).toBe("forsen");
});

test("returns null when no roster streamer is named", () => {
  expect(attribute("+50 -> someone_else", ["forsen"])).toBeNull();
});

test("returns null for a message naming two roster streamers", () => {
  // A raid line names both channels. Attributing it to whichever matched
  // first would be a guess, and a wrong guess silently puts one
  // streamer's activity on another's card.
  expect(attribute("forsen raided alpha", ["forsen", "alpha"])).toBeNull();
});

test("requires a word boundary", () => {
  // "alpha" must not match inside "alphabet", or a streamer with a short
  // login would be credited with half the feed.
  expect(attribute("alphabet soup", ["alpha"])).toBeNull();
});

test("treats an underscore as part of the name", () => {
  // Twitch logins allow underscores, so \b would wrongly split
  // "alpha_bot" and attribute it to "alpha".
  expect(attribute("+10 -> alpha_bot", ["alpha"])).toBeNull();
});

test("matches a login at the start and end of a message", () => {
  expect(attribute("forsen went live", ["forsen"])).toBe("forsen");
  expect(attribute("bonus claimed for forsen", ["forsen"])).toBe("forsen");
});

test("matches a login containing an underscore", () => {
  expect(attribute("+10 -> some_streamer", ["some_streamer"])).toBe("some_streamer");
});

test("returns null for a null or empty message", () => {
  expect(attribute(null, ["alpha"])).toBeNull();
  expect(attribute("", ["alpha"])).toBeNull();
});

test("returns null for an empty roster", () => {
  expect(attribute("+50 -> forsen", [])).toBeNull();
});

test("counts one streamer named twice as unambiguous", () => {
  // Repetition is not ambiguity: the line is still about one channel.
  expect(attribute("forsen: bonus for forsen", ["forsen", "alpha"])).toBe("forsen");
});
