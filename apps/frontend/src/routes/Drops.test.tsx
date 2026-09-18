import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Drops } from "./Drops.js";
import { dragBy, renderApp, restoreRects, stubRowRects } from "../test-utils.js";

const aDrop = {
  id: "d1", name: "Crate", benefits: ["Crate"],
  requiredMinutes: 60, minutes: 0, status: "not-started",
};

const aHelmet = {
  id: "d2", name: "Gilded Helmet", benefits: ["Gilded Helmet"],
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
      drops: [aHelmet], status: "partial" },
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

afterEach(() => { vi.unstubAllGlobals(); restoreRects(); });

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

test("filters by the name of a drop inside a campaign", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  // The reward is often the only name a player knows -- they are hunting
  // the helmet, not whatever the campaign behind it is called.
  await userEvent.type(screen.getByLabelText(/filter/i), "Gilded Helmet");
  expect(screen.getByText("Beta Campaign")).toBeTruthy();
  expect(screen.queryByText("Alpha Campaign")).toBeNull();
});

test("opens a campaign matched only by its drop", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "Gilded Helmet");
  // Otherwise the card that survived the filter shows nothing containing
  // what was typed, and the match looks like a bug.
  expect(screen.getByText("Gilded Helmet")).toBeTruthy();
});

test("closes a drop-matched campaign again when the filter is cleared", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "Gilded Helmet");
  expect(screen.getByText("Gilded Helmet")).toBeTruthy();
  await userEvent.clear(screen.getByLabelText(/filter/i));
  // The card was opened by the search, not by the reader, so it should
  // not stay open and cost the list its scannability.
  //
  // Asserted on aria-expanded rather than on the drop being gone:
  // Collapse unmounts its content only once the CSS transition ends, and
  // jsdom never fires transitionend, so the row stays in the test DOM
  // however long we wait. aria-expanded is the state itself.
  await waitFor(() => expect(
    screen.getByRole("button", { name: /Beta Campaign, 1 drops/ }),
  ).toHaveAttribute("aria-expanded", "false"));
});

test("a reader can still close a card the filter opened", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "Gilded Helmet");
  const row = screen.getByRole("button", { name: /Beta Campaign, 1 drops/ });
  expect(row).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(row);
  // Forcing it open must not mean nailing it open. On aria-expanded for
  // the same reason as above: jsdom fires no transitionend, so Collapse
  // never unmounts the drop it is closing over.
  expect(row).toHaveAttribute("aria-expanded", "false");
});

test("leaves a campaign matched by its own name closed", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "Beta Campaign");
  // The name is already on the collapsed row, so there is nothing to
  // reveal and forcing it open would just cost the reader space.
  expect(
    screen.getByRole("button", { name: /Beta Campaign, 1 drops/ }),
  ).toHaveAttribute("aria-expanded", "false");
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

// --- subscriptions ---

const asSub = (over: object = {}) => ({
  id: "s1", kind: "campaign", targetId: "c1", label: "Alpha Campaign",
  poolSize: 3, rank: 0, channels: [], ...over,
});

/** Routes the stub by URL, so the page can read three endpoints. */
function withSubs(
  subscriptions: unknown[],
  restart: { pending: boolean } = { pending: false },
) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("/api/subscriptions")) {
      return { ok: true, status: 200, json: async () => ({ subscriptions }) };
    }
    if (url.startsWith("/api/status")) {
      return {
        ok: true, status: 200,
        json: async () => ({ pendingRestart: {
          pending: restart.pending, dueAt: null, reason: null,
        } }),
      };
    }
    return { ok: true, status: 200, json: async () => body };
  }));
}

test("subscribing posts the campaign the button belongs to", async () => {
  withSubs([]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  // Found via the card, not by index: the list is sorted by deadline, so
  // the first Subscribe button is not necessarily the first fixture.
  const card = screen.getAllByTestId("campaign-card")
    .find((c) => c.textContent?.includes("Beta Campaign"))!;
  await userEvent.click(
    within(card).getByRole("button", { name: /^subscribe$/i }),
  );
  await waitFor(() => {
    const post = calls.find(
      (c) => c.url === "/api/subscriptions" && c.init?.method === "POST",
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      kind: "campaign", targetId: "c2", label: "Beta Campaign",
    });
  });
});

test("an already-subscribed campaign offers unsubscribe instead", async () => {
  withSubs([asSub()]);
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /unsubscribe/i })).toBeTruthy());
});

test("the subscriptions panel lists the channels each one resolved to", async () => {
  withSubs([asSub({ channels: ["beta", "gamma"] })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const panel = screen.getByTestId("subscriptions");
  expect(panel.textContent).toMatch(/beta/);
  expect(panel.textContent).toMatch(/gamma/);
});

test("the panel is hidden when nothing is subscribed", async () => {
  withSubs([]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  expect(screen.queryByTestId("subscriptions")).toBeNull();
});

test("re-resolve asks the engine for a pass now", async () => {
  withSubs([asSub()]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: /re-resolve/i }));
  await waitFor(() => expect(calls.some(
    (c) => c.url === "/api/subscriptions/resolve",
  )).toBe(true));
});

test("unsubscribing posts the removal", async () => {
  withSubs([asSub()]);
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /unsubscribe/i })).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: /unsubscribe/i }));
  await waitFor(() => expect(calls.some(
    (c) => c.url === "/api/subscriptions/s1/remove",
  )).toBe(true));
});

test("resolved channels are not called watched until the miner restarts", async () => {
  // The channels sit in the config doing nothing until then, so calling
  // them "watching" would be a claim about the miner that is not true.
  withSubs([asSub({ channels: ["beta"] })], { pending: true });
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const panel = screen.getByTestId("subscriptions");
  expect(panel.textContent).toMatch(/after the restart/i);
  expect(panel.textContent).toMatch(/beta/);
});

test("once nothing is pending the channels read as watched", async () => {
  withSubs([asSub({ channels: ["beta"] })], { pending: false });
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  expect(screen.getByTestId("subscriptions").textContent).toMatch(/watching beta/i);
});

test("the panel explains when the engine re-checks", async () => {
  // Otherwise the fifteen-minute cadence is invisible and the page looks
  // static when it is not.
  withSubs([asSub()]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  expect(screen.getByTestId("subscriptions").textContent)
    .toMatch(/every 15 minutes/i);
});

test("subscribing shows the wait on the row that was clicked", async () => {
  // Inline, so the feedback lands where the click did and cannot be
  // mistaken for another campaign's.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/subscriptions" && init?.method === "POST") await gate;
    const payload = url.startsWith("/api/subscriptions")
      ? { subscriptions: [] }
      : url.startsWith("/api/status")
        ? { pendingRestart: { pending: false, dueAt: null, reason: null } }
        : body;
    return { ok: true, status: 200, json: async () => payload };
  }));

  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  const card = screen.getAllByTestId("campaign-card")
    .find((c) => c.textContent?.includes("Alpha Campaign"))!;
  await userEvent.click(within(card).getByRole("button", { name: /^subscribe$/i }));

  await waitFor(() =>
    expect(within(card).getByTestId("campaign-busy")).toBeTruthy());
  expect(within(card).getByTestId("campaign-busy").textContent)
    .toMatch(/finding channels/i);
  release!();
  await waitFor(() =>
    expect(within(card).queryByTestId("campaign-busy")).toBeNull());
});

test("only the clicked campaign shows the wait", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/subscriptions" && init?.method === "POST") await gate;
    const payload = url.startsWith("/api/subscriptions")
      ? { subscriptions: [] }
      : url.startsWith("/api/status")
        ? { pendingRestart: { pending: false, dueAt: null, reason: null } }
        : body;
    return { ok: true, status: 200, json: async () => payload };
  }));

  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  const cards = screen.getAllByTestId("campaign-card");
  const clicked = cards.find((c) => c.textContent?.includes("Alpha Campaign"))!;
  const other = cards.find((c) => c.textContent?.includes("Beta Campaign"))!;
  await userEvent.click(within(clicked).getByRole("button", { name: /^subscribe$/i }));

  await waitFor(() =>
    expect(within(clicked).getByTestId("campaign-busy")).toBeTruthy());
  expect(within(other).queryByTestId("campaign-busy")).toBeNull();
  release!();
});
test("the banner names what is happening for a re-resolve", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/subscriptions/resolve") await gate;
    const payload = url.startsWith("/api/subscriptions")
      ? { subscriptions: [asSub()] }
      : url.startsWith("/api/status")
        ? { pendingRestart: { pending: false, dueAt: null, reason: null } }
        : body;
    return { ok: true, status: 200, json: async () => payload };
  }));

  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  await userEvent.click(screen.getByRole("button", { name: /re-resolve/i }));
  await waitFor(() =>
    expect(screen.getByTestId("resolving").textContent).toMatch(/re-checking/i));
  release!();
});

test("no banner when nothing is running", async () => {
  withSubs([asSub()]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  expect(screen.queryByTestId("resolving")).toBeNull();
});


test("a subscription with nobody live says so, rather than searching forever", async () => {
  // A campaign whose game has no live drops-enabled streamers resolves
  // to an empty pool. "finding channels…" there is a lie that never
  // resolves; the engine already looked and found nothing.
  withSubs([asSub({ channels: [] })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  expect(screen.getByTestId("subscriptions").textContent)
    .toMatch(/nobody is streaming/i);
});

test("Remove is disabled while a removal is in flight", async () => {
  // Clicking twice would fire a second POST against a subscription the
  // first call is already deleting.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/remove")) await gate;
    const payload = url.startsWith("/api/subscriptions")
      ? { subscriptions: [asSub(), asSub({ id: "s2", targetId: "c2", label: "Beta" })] }
      : url.startsWith("/api/status")
        ? { pendingRestart: { pending: false, dueAt: null, reason: null } }
        : body;
    return { ok: true, status: 200, json: async () => payload };
  }));

  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const removes = within(screen.getByTestId("subscriptions"))
    .getAllByRole("button", { name: /^remove$/i });
  await userEvent.click(removes[0]!);

  await waitFor(() => expect(screen.getByTestId("resolving")).toBeTruthy());
  const after = within(screen.getByTestId("subscriptions"))
    .getAllByRole("button", { name: /^remove$/i });
  // Every Remove, not just the one clicked: they share one busy state
  // and a second removal cannot be meaningfully started mid-flight.
  for (const b of after) expect(b.hasAttribute("disabled")).toBe(true);
  release!();
});

test("Re-resolve is disabled while a removal is in flight", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/remove")) await gate;
    const payload = url.startsWith("/api/subscriptions")
      ? { subscriptions: [asSub()] }
      : url.startsWith("/api/status")
        ? { pendingRestart: { pending: false, dueAt: null, reason: null } }
        : body;
    return { ok: true, status: 200, json: async () => payload };
  }));

  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  await userEvent.click(
    within(screen.getByTestId("subscriptions"))
      .getByRole("button", { name: /^remove$/i }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /re-resolve/i })
      .hasAttribute("disabled")).toBe(true));
  release!();
});

test("removing from the panel also freezes that campaign's card button", async () => {
  // The panel and the card act on the same subscription, so leaving the
  // card live invites a second delete of something already going.
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/remove")) await gate;
    const payload = url.startsWith("/api/subscriptions")
      ? { subscriptions: [asSub({ targetId: "c1" })] }
      : url.startsWith("/api/status")
        ? { pendingRestart: { pending: false, dueAt: null, reason: null } }
        : body;
    return { ok: true, status: 200, json: async () => payload };
  }));

  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  await userEvent.click(
    within(screen.getByTestId("subscriptions"))
      .getByRole("button", { name: /^remove$/i }),
  );
  await waitFor(() => expect(screen.getByTestId("resolving")).toBeTruthy());
  const card = screen.getAllByTestId("campaign-card")
    .find((c) => c.textContent?.includes("Alpha Campaign"))!;
  expect(within(card).getByRole("button", { name: /unsubscribe/i })
    .hasAttribute("disabled")).toBe(true);
  release!();
});

// --- reordering subscriptions ---

/**
 * Two subscriptions in rank order, the fixture every reorder test drags.
 * Ranks are what the engine sorts by, so they are set explicitly rather
 * than left to the array order.
 */
const twoSubs = [
  asSub({ id: "s1", targetId: "c1", label: "Alpha Campaign", rank: 0 }),
  asSub({ id: "s2", targetId: "c2", label: "Beta Campaign", rank: 1 }),
];

test("the rank of each subscription is on the row", async () => {
  withSubs(twoSubs);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  // The order is the whole point of the panel -- unnumbered it reads as
  // decoration rather than the thing that picks what gets watched first.
  const rows = screen.getAllByTestId("subscription-row");
  expect(rows[0].textContent).toMatch(/1/);
  expect(rows[0].textContent).toContain("Alpha Campaign");
  expect(rows[1].textContent).toContain("Beta Campaign");
});

test("dragging a subscription down posts the new order", async () => {
  stubRowRects("subscription-row");
  withSubs(twoSubs);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());

  const handles = screen.getAllByRole("button", { name: /reorder/i });
  await dragBy(handles[0], 60);

  await waitFor(() => {
    const post = calls.find((c) => c.url === "/api/subscriptions/reorder");
    expect(post).toBeTruthy();
    // The endpoint rejects anything short of the full set, so the whole
    // list goes up, in its new order.
    expect(JSON.parse(String(post?.init?.body))).toEqual({ ids: ["s2", "s1"] });
  });
});

test("a reordered row moves before the server answers", async () => {
  stubRowRects("subscription-row");
  withSubs(twoSubs);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());

  await dragBy(screen.getAllByRole("button", { name: /reorder/i })[0], 60);

  // Optimistic: a row that springs back while the POST is in flight reads
  // as the drag having failed.
  const rows = screen.getAllByTestId("subscription-row");
  expect(rows[0].textContent).toContain("Beta Campaign");
  expect(rows[1].textContent).toContain("Alpha Campaign");
});

test("the drag handle reorders from the keyboard alone", async () => {
  stubRowRects("subscription-row");
  withSubs(twoSubs);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());

  // Space lifts, arrow moves, space drops -- the only reorder path for a
  // keyboard user, and the reason the grip is a button at all.
  screen.getAllByRole("button", { name: /reorder/i })[0].focus();
  await userEvent.keyboard("{ }");
  await userEvent.keyboard("{ArrowDown}");
  await userEvent.keyboard("{ }");

  await waitFor(() => {
    const post = calls.find((c) => c.url === "/api/subscriptions/reorder");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ ids: ["s2", "s1"] });
  });
});

test("a rejected reorder puts the rows back", async () => {
  stubRowRects("subscription-row");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/subscriptions/reorder") {
      return { ok: false, status: 500, json: async () => ({ error: "nope" }) };
    }
    if (url.startsWith("/api/subscriptions")) {
      return { ok: true, status: 200, json: async () => ({ subscriptions: twoSubs }) };
    }
    if (url.startsWith("/api/status")) {
      return { ok: true, status: 200, json: async () => ({
        pendingRestart: { pending: false, dueAt: null, reason: null },
      }) };
    }
    return { ok: true, status: 200, json: async () => body };
  }));
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());

  await dragBy(screen.getAllByRole("button", { name: /reorder/i })[0], 60);

  // Leaving the optimistic order up would show an order the engine is not
  // using, which is worse than the drag visibly not taking.
  await waitFor(() => {
    const rows = screen.getAllByTestId("subscription-row");
    expect(rows[0].textContent).toContain("Alpha Campaign");
    expect(rows[1].textContent).toContain("Beta Campaign");
  });
});

test("a lone subscription offers no drag handle", async () => {
  withSubs([asSub()]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  // Nothing to reorder against: a grip that cannot do anything is a
  // promise the panel does not keep.
  expect(screen.queryByRole("button", { name: /reorder/i })).toBeNull();
});
