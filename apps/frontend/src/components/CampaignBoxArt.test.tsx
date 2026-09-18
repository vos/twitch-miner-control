import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { CampaignBoxArt, sized } from "./CampaignBoxArt.js";
import { renderApp } from "../test-utils.js";

test("rewrites the CDN size to twice what the tile draws", () => {
  // Twice, for a retina display; the URL carries its dimensions in the
  // filename, so asking for the right ones is free.
  expect(sized("https://cdn/a/g1_IGDB-285x380.jpg", 88))
    .toBe("https://cdn/a/g1_IGDB-176x234.jpg");
});

test("leaves a URL without dimensions untouched", () => {
  // An invented filename 404s, which would replace real art with a
  // placeholder -- worse than fetching one image at the wrong size.
  expect(sized("https://cdn/a/plain.jpg", 88)).toBe("https://cdn/a/plain.jpg");
});

test("renders a letter tile when there is no art", () => {
  renderApp(<CampaignBoxArt url={null} displayName="Once Human" />);
  expect(screen.getByTestId("box-art-fallback").textContent).toBe("O");
});

test("treats an absent field the same as a null one", () => {
  // A catalogue persisted before box art was parsed has no such key.
  renderApp(<CampaignBoxArt url={undefined} displayName="Once Human" />);
  expect(screen.getByTestId("box-art-fallback")).toBeTruthy();
});

test("the art is decorative, the game being named beside it", () => {
  renderApp(<CampaignBoxArt url="https://cdn/a/g_IGDB-285x380.jpg" displayName="A" />);
  expect(screen.getByTestId("box-art").getAttribute("alt")).toBe("");
});

test("links the art to the game's Twitch category when there is a slug", () => {
  // The image already depicts the game, so it can carry the link
  // without a coloured anchor competing with the card's other accents.
  renderApp(<CampaignBoxArt url={null} displayName="Once Human" slug="once-human" />);
  const link = screen.getByRole("link", { name: /once human on twitch/i });
  // ?filter=drops narrows the directory to channels actually running
  // drops, which is Twitch's own link for "a participating live channel".
  expect(link.getAttribute("href"))
    .toBe("https://twitch.tv/directory/category/once-human?filter=drops");
});

test("opens the category in a new tab, this page being a live control panel", () => {
  renderApp(<CampaignBoxArt url={null} displayName="A" slug="a-game" />);
  const link = screen.getByRole("link", { name: /on twitch/i });
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toMatch(/noreferrer/);
});

test("renders plain art when there is no slug to link to", () => {
  // A slug invented from a display name lands on a 404, so no link at
  // all beats a broken one.
  renderApp(<CampaignBoxArt url={null} displayName="Once Human" slug="" />);
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByTestId("box-art-fallback")).toBeTruthy();
});
