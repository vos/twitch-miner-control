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
      startsAt: 1, endsAt: Date.now() + 86_400_000,
      drops: [aDrop], status: "untouched" },
    { id: "c2", name: "Beta Campaign",
      game: { id: "g2", slug: "beta-game", displayName: "Beta Game" },
      startsAt: 1, endsAt: Date.now() + 86_400_000,
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

test("says the campaigns are not from Twitch, and links the source", async () => {
  // Presenting someone else's data as Twitch's own would misrepresent
  // both, and it explains why this list can differ from
  // twitch.tv/drops/campaigns.
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("catalogue-source")).toBeTruthy());
  const note = screen.getByTestId("catalogue-source");
  expect(note.textContent).toMatch(/not twitch/i);
  const link = note.querySelector("a");
  expect(link?.getAttribute("href")).toBe("https://twitch-drops.fenrisapps.com/");
  expect(link?.getAttribute("target")).toBe("_blank");
  // Without noreferrer the opened page gets a handle on this one.
  expect(link?.getAttribute("rel")).toMatch(/noopener/);
  // The split matters: the campaigns are third-party, the progress is not.
  expect(note.textContent).toMatch(/progress comes from twitch/i);
});

test("orders campaigns by the soonest deadline", async () => {
  // What the page is opened to find out: what runs out next. The source
  // returns its own order, which the user cannot see or reason about.
  const at = (days: number) => Date.now() + days * 86_400_000;
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "late", name: "Late One", endsAt: at(9) },
      { ...payload.campaigns[0], id: "soon", name: "Soon One", endsAt: at(1) },
      { ...payload.campaigns[0], id: "mid", name: "Mid One", endsAt: at(4) },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Soon One")).toBeTruthy());
  const names = screen.getAllByTestId("campaign-card")
    .map((c) => c.querySelector("p, span, div")?.textContent);
  const order = ["Soon One", "Mid One", "Late One"].map((n) =>
    names.findIndex((t) => t?.includes(n)));
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("a campaign with no deadline sorts last, not first", async () => {
  // Infinity, not 0: an unknown deadline is not an urgent one.
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "none", name: "No Deadline", endsAt: null },
      { ...payload.campaigns[0], id: "soon", name: "Soon One",
        endsAt: Date.now() + 86_400_000 },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Soon One")).toBeTruthy());
  const cards = screen.getAllByTestId("campaign-card");
  expect(cards[0]?.textContent).toMatch(/Soon One/);
  expect(cards[1]?.textContent).toMatch(/No Deadline/);
});

test("campaigns ending together keep a stable order", async () => {
  // Ties break by name, so a refresh does not reshuffle the list.
  const same = Date.now() + 86_400_000;
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "b", name: "Bravo", endsAt: same },
      { ...payload.campaigns[0], id: "a", name: "Alpha", endsAt: same },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
  const cards = screen.getAllByTestId("campaign-card");
  expect(cards[0]?.textContent).toMatch(/Alpha/);
});

test("an ended campaign sinks to the bottom, not the top", async () => {
  // Sorting purely by deadline puts expired campaigns in the most
  // prominent row on the page -- the one thing that can no longer be
  // acted on.
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "over", name: "Over Already",
        endsAt: Date.now() - 86_400_000 },
      { ...payload.campaigns[0], id: "soon", name: "Soon One",
        endsAt: Date.now() + 86_400_000 },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Soon One")).toBeTruthy());
  const cards = screen.getAllByTestId("campaign-card");
  expect(cards[0]?.textContent).toMatch(/Soon One/);
  expect(cards[1]?.textContent).toMatch(/Over Already/);
});

test("an ended campaign is still listed, not hidden", async () => {
  // The tracker still lists them, and a drop already earned is worth
  // seeing.
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "over", name: "Over Already",
        endsAt: Date.now() - 86_400_000 },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Over Already")).toBeTruthy());
});

test("campaigns with progress sort above everything live", async () => {
  // What you have already committed watch time to is what you most need
  // to see, even when something else expires sooner.
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "urgent", name: "Urgent Untouched",
        status: "untouched", endsAt: Date.now() + 3_600_000 },
      { ...payload.campaigns[0], id: "started", name: "Started One",
        status: "partial", endsAt: Date.now() + 7 * 86_400_000 },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Started One")).toBeTruthy());
  const cards = screen.getAllByTestId("campaign-card");
  expect(cards[0]?.textContent).toMatch(/Started One/);
  expect(cards[1]?.textContent).toMatch(/Urgent Untouched/);
});

test("collected campaigns are not promoted, having nothing left to do", async () => {
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "done", name: "All Done",
        status: "collected", endsAt: Date.now() + 7 * 86_400_000 },
      { ...payload.campaigns[0], id: "soon", name: "Soon One",
        status: "untouched", endsAt: Date.now() + 3_600_000 },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Soon One")).toBeTruthy());
  const cards = screen.getAllByTestId("campaign-card");
  expect(cards[0]?.textContent).toMatch(/Soon One/);
});

test("within the progress tier, the soonest deadline still wins", async () => {
  // 40/60 minutes expiring tonight outranks 10/60 with a week left.
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "later", name: "Later Progress",
        status: "partial", endsAt: Date.now() + 7 * 86_400_000 },
      { ...payload.campaigns[0], id: "tonight", name: "Tonight Progress",
        status: "partial", endsAt: Date.now() + 3_600_000 },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Tonight Progress")).toBeTruthy());
  const cards = screen.getAllByTestId("campaign-card");
  expect(cards[0]?.textContent).toMatch(/Tonight Progress/);
});

test("an ended campaign stays at the bottom even with progress on it", async () => {
  // Frozen progress is not actionable, whatever tier it would otherwise
  // have earned.
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "over", name: "Over With Progress",
        status: "partial", endsAt: Date.now() - 86_400_000 },
      { ...payload.campaigns[0], id: "live", name: "Live Untouched",
        status: "untouched", endsAt: Date.now() + 86_400_000 },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Live Untouched")).toBeTruthy());
  const cards = screen.getAllByTestId("campaign-card");
  expect(cards[0]?.textContent).toMatch(/Live Untouched/);
  expect(cards[1]?.textContent).toMatch(/Over With Progress/);
});
