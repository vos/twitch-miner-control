import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { GiftSubsSection } from "./GiftSubsSection.js";
import type { GiftSub } from "../api/useLiveState.js";

const DAY = 86_400_000;

const kitten: GiftSub = {
  id: "g1", tier: 1, product: "KDRkitten Sub",
  gifter: { login: "badbeard95", displayName: "BadBeard95" },
  target: { channelId: "42", login: "kdrkitten", displayName: "KDRkitten" },
  endsAt: Date.now() + 9 * DAY + 60_000,
};
const elsewhere: GiftSub = {
  id: "g2", tier: 2, product: "Other Sub", gifter: null,
  target: { channelId: "43", login: "other", displayName: "Other" },
  endsAt: Date.now() + 3 * DAY,
};
const turbo: GiftSub = {
  id: "g3", tier: "Custom", product: "Twitch Turbo", gifter: null, target: null,
  endsAt: Date.now() + 20 * DAY,
};

const fetchMock = vi.fn();
beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const respond = (body: unknown, ok = true) => fetchMock.mockResolvedValueOnce({
  ok, status: ok ? 200 : 500, json: async () => body,
});

const view = (gifts: GiftSub[], onOpenStreamer = vi.fn()) => {
  renderApp(
    <GiftSubsSection gifts={gifts} roster={["kdrkitten"]} onOpenStreamer={onOpenStreamer} />,
  );
  return onOpenStreamer;
};

test("counts every gift in the heading", () => {
  view([kitten, elsewhere, turbo]);
  expect(screen.getByTestId("gifts-heading")).toHaveTextContent("GIFT SUBS · 3");
});

test("lists a channel gift with its tier, gifter and end", () => {
  view([kitten]);
  const row = screen.getByTestId("gift-row");
  expect(row).toHaveTextContent("KDRkitten");
  expect(row).toHaveTextContent("Tier 1 gift sub");
  expect(row).toHaveTextContent("BadBeard95");
  expect(row).toHaveTextContent("in 9d");
});

test("lists a non-channel gift by its product", () => {
  view([turbo]);
  const row = screen.getByTestId("gift-row");
  expect(row).toHaveTextContent("Twitch Turbo");
  expect(row).toHaveTextContent(/anonymous/i);
});

test("opens the streamer's detail for a channel on the dashboard", async () => {
  const onOpen = view([kitten]);
  await userEvent.click(screen.getByRole("button", { name: /KDRkitten/ }));
  expect(onOpen).toHaveBeenCalledWith("kdrkitten");
});

test("links a channel off the dashboard to Twitch instead", () => {
  view([elsewhere]);
  const row = screen.getByTestId("gift-row");
  expect(within(row).getByRole("link", { name: "Other" }))
    .toHaveAttribute("href", "https://twitch.tv/other");
});

test("keeps the heading when there are none, so refresh stays reachable", () => {
  // The refresh button is the only way to pick up a gift the miner never
  // reports; hiding the section when empty would hide the button too.
  view([]);
  expect(screen.getByTestId("gifts-heading")).toHaveTextContent("GIFT SUBS · 0");
  expect(screen.getByText(/no active gift subs/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /refresh gift subs/i })).toBeInTheDocument();
});

test("the refresh button refetches the list", async () => {
  respond({ giftSubs: [kitten], error: null });
  view([]);
  await userEvent.click(screen.getByRole("button", { name: /refresh gift subs/i }));
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/gift-subs/refresh", expect.objectContaining({ method: "POST" }),
  );
});

test("a refresh that failed on Twitch's side says so", async () => {
  respond({ giftSubs: [kitten], error: "gql exploded" });
  view([kitten]);
  await userEvent.click(screen.getByRole("button", { name: /refresh gift subs/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent("gql exploded");
  // The last list stays: an error is not a claim the gifts are gone.
  expect(screen.getByTestId("gift-row")).toBeInTheDocument();
});

test("a refresh that never reached the backend says so", async () => {
  respond({ error: "backend down" }, false);
  view([]);
  await userEvent.click(screen.getByRole("button", { name: /refresh gift subs/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent("backend down");
});

test("collapses from its heading", async () => {
  view([kitten]);
  await userEvent.click(screen.getByTestId("gifts-heading"));
  expect(screen.queryByTestId("gift-row")).not.toBeInTheDocument();
  // The refresh button is beside the toggle, not inside it.
  expect(screen.getByRole("button", { name: /refresh gift subs/i })).toBeInTheDocument();
});
