import { expect, test } from "vitest";
import { isExternal, parseLink } from "./deepLink.js";

test("a link names a screen and its params", () => {
  expect(parseLink("/?open=drops&campaign=c1")).toEqual({ screen: "drops", params: { campaign: "c1" } });
  expect(parseLink("?open=insights&period=week")).toEqual({ screen: "insights", params: { period: "week" } });
  expect(parseLink("/?open=dashboard&streamer=alpha")).toEqual({ screen: "dashboard", streamer: "alpha" });
  expect(parseLink("/?open=logs")).toEqual({ screen: "logs" });
});

test("anything else is not an app link", () => {
  expect(parseLink("/")).toBeNull();
  expect(parseLink("")).toBeNull();
  expect(parseLink("https://github.com/vos/twitch-miner-control?open=drops")).toBeNull();
  expect(parseLink("/?open=insights&period=year")).toEqual({ screen: "insights" });
});

test("absolute http links are external", () => {
  expect(isExternal("https://github.com/x")).toBe(true);
  expect(isExternal("/?open=drops")).toBe(false);
});
