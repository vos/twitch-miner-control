import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Drops } from "./Drops.js";
import { renderApp } from "../test-utils.js";

const aDrop = {
  id: "d1", name: "Crate", benefits: ["Crate"],
  requiredMinutes: 60, minutes: 0, status: "not-started",
};

const payload = {
  campaigns: [
    { id: "c1", name: "Alpha Campaign",
      game: { id: "g1", slug: "alpha-game", displayName: "Alpha Game" },
      startsAt: 1, endsAt: Date.now() + 86_400_000, allowChannelIds: [],
      drops: [aDrop], status: "untouched" },
    { id: "c2", name: "Beta Campaign",
      game: { id: "g2", slug: "beta-game", displayName: "Beta Game" },
      startsAt: 1, endsAt: Date.now() + 86_400_000, allowChannelIds: [],
      drops: [aDrop], status: "partial" },
  ],
  catalogueFetchedAt: Date.now() - 3_600_000,
  catalogueStale: false,
  catalogueAvailable: true,
  catalogueError: null,
  progressFetchedAt: Date.now() - 60_000,
  progressAvailable: true,
};

let calls: Array<{ url: string; init?: RequestInit }>;
let body: unknown;

beforeEach(() => {
  calls = [];
  body = payload;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

test("lists every campaign the server returns", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  expect(screen.getByText("Beta Campaign")).toBeTruthy();
});

test("filters by campaign name", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "Beta");
  expect(screen.queryByText("Alpha Campaign")).toBeNull();
  expect(screen.getByText("Beta Campaign")).toBeTruthy();
});

test("filtering ignores case", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "alpha");
  expect(screen.getByText("Alpha Campaign")).toBeTruthy();
});

test("filters by game", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "Beta Game");
  // The game is a campaign's most useful handle, so the same box matches it.
  expect(screen.getByText("Beta Campaign")).toBeTruthy();
  expect(screen.queryByText("Alpha Campaign")).toBeNull();
});

test("says so when a filter matches nothing", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "nothing matches this");
  expect(screen.getByTestId("campaigns-empty")).toBeTruthy();
});

test("shows both cache ages separately", async () => {
  // Two clocks a day apart -- one merged "updated N ago" would describe
  // neither.
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("catalogue-age")).toBeTruthy());
  expect(screen.getByTestId("progress-age")).toBeTruthy();
});

test("warns when progress could not be read", async () => {
  body = { ...payload, progressAvailable: false };
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByTestId("progress-unavailable")).toBeTruthy());
});

test("says when the campaign list itself is stale", async () => {
  body = { ...payload, catalogueStale: true };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("catalogue-stale")).toBeTruthy());
  // Stale is not empty: the campaigns still render.
  expect(screen.getByText("Alpha Campaign")).toBeTruthy();
});

test("refresh posts to the refresh route", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
  await waitFor(() =>
    expect(calls.some((c) => c.url === "/api/campaigns/refresh")).toBe(true));
});

test("reports a failed load instead of rendering an empty list", async () => {
  body = new Error("network down");
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("campaigns-error")).toBeTruthy());
});

test("an account with no campaigns says so", async () => {
  body = { ...payload, campaigns: [] };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("campaigns-empty")).toBeTruthy());
});

test("an unreadable campaign list says so instead of claiming none exist", async () => {
  // The bug this exists to prevent: the page reported "No drop campaigns
  // are running" when the source had actually failed -- a confident claim
  // about Twitch made from an empty variable.
  body = {
    ...payload, campaigns: [], catalogueAvailable: false,
    catalogueError: "source format changed",
  };
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByTestId("catalogue-unavailable")).toBeTruthy());
  expect(screen.queryByText(/no drop campaigns are running/i)).toBeNull();
});

test("the unavailable banner shows why, for anyone who can act on it", async () => {
  body = {
    ...payload, campaigns: [], catalogueAvailable: false,
    catalogueError: "HTTP 503",
  };
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByTestId("catalogue-unavailable").textContent)
      .toMatch(/503/));
});

test("unavailable outranks stale rather than showing both", async () => {
  body = {
    ...payload, campaigns: [], catalogueAvailable: false,
    catalogueStale: true, catalogueError: "down",
  };
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByTestId("catalogue-unavailable")).toBeTruthy());
  expect(screen.queryByTestId("catalogue-stale")).toBeNull();
});

test("a genuinely empty list still says none are running", async () => {
  // Available and empty is a real answer, and must keep reading as one.
  body = { ...payload, campaigns: [] };
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByText(/no drop campaigns are running/i)).toBeTruthy());
  expect(screen.queryByTestId("catalogue-unavailable")).toBeNull();
});
