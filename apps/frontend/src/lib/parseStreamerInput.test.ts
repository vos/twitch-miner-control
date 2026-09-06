import { expect, test } from "vitest";
import { parseStreamerInput } from "./parseStreamerInput.js";

test("passes a bare username through", () => {
  expect(parseStreamerInput("mewmiyu")).toBe("mewmiyu");
});

test("trims surrounding whitespace", () => {
  expect(parseStreamerInput("  mewmiyu \n")).toBe("mewmiyu");
});

test("pulls the login out of a full channel link", () => {
  expect(parseStreamerInput("https://www.twitch.tv/mewmiyu")).toBe("mewmiyu");
});

test("accepts a link without the scheme or the www", () => {
  expect(parseStreamerInput("twitch.tv/mewmiyu")).toBe("mewmiyu");
  expect(parseStreamerInput("http://m.twitch.tv/mewmiyu")).toBe("mewmiyu");
});

test("drops a trailing slash, query and fragment", () => {
  expect(parseStreamerInput("https://www.twitch.tv/mewmiyu/")).toBe("mewmiyu");
  expect(parseStreamerInput("https://www.twitch.tv/mewmiyu?tt_medium=live")).toBe("mewmiyu");
  expect(parseStreamerInput("https://www.twitch.tv/mewmiyu#about")).toBe("mewmiyu");
});

test("keeps the case the link was written in", () => {
  expect(parseStreamerInput("https://www.twitch.tv/MewMiyu")).toBe("MewMiyu");
});

test("strips a leading @", () => {
  expect(parseStreamerInput("@mewmiyu")).toBe("mewmiyu");
});

test("rejects a link to some other site", () => {
  expect(parseStreamerInput("https://youtube.com/mewmiyu")).toBeNull();
  expect(parseStreamerInput("https://nottwitch.tv/mewmiyu")).toBeNull();
});

test("rejects a twitch link that is not a channel", () => {
  // Directory and video URLs share the host but the first segment is not
  // a login; "videos" passes the shape check, so the deeper path is what
  // has to disqualify it.
  expect(parseStreamerInput("https://www.twitch.tv/directory/game/Chess")).toBeNull();
  expect(parseStreamerInput("https://www.twitch.tv/mewmiyu/videos")).toBeNull();
});

test("rejects what is not username-shaped", () => {
  expect(parseStreamerInput("")).toBeNull();
  expect(parseStreamerInput("ab")).toBeNull();
  expect(parseStreamerInput("mew miyu")).toBeNull();
  expect(parseStreamerInput("mew-miyu")).toBeNull();
});
