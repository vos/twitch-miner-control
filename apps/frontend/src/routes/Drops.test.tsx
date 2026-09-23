import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MantineProvider } from "@mantine/core";
import { Drops } from "./Drops.js";
import { theme } from "../theme.js";
import { dragBy, renderApp, restoreRects, stubRowRects } from "../test-utils.js";

const aDrop = {
  id: "d1", name: "Crate", benefits: [{ name: "Crate", imageUrl: null }],
  requiredMinutes: 60, minutes: 0, status: "not-started",
};

const aHelmet = {
  id: "d2", name: "Gilded Helmet", benefits: [{ name: "Gilded Helmet", imageUrl: null }],
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
    screen.getByRole("button", { name: /Beta Campaign, 1 drop/ }),
  ).toHaveAttribute("aria-expanded", "false"));
});

test("a reader can still close a card the filter opened", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "Gilded Helmet");
  const row = screen.getByRole("button", { name: /Beta Campaign, 1 drop/ });
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
    screen.getByRole("button", { name: /Beta Campaign, 1 drop/ }),
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

test("never-fetched progress reads as never, not as 1970", async () => {
  // Without a Twitch login the inventory is never fetched and its
  // timestamp stays 0, which formatted as an age read "20715d ago" --
  // the epoch, presented as though progress had genuinely been read
  // once, 56 years ago.
  body = { ...payload, progressFetchedAt: 0, progressAvailable: false };
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByTestId("progress-age").textContent).toBe("Progress never read"));
});

test("a catalogue that has never been read says so too", async () => {
  body = {
    ...payload, catalogueFetchedAt: 0, catalogueAvailable: false, campaigns: [],
  };
  renderApp(<Drops />);
  await waitFor(() =>
    expect(screen.getByTestId("catalogue-age").textContent)
      .toBe("Campaigns never read"));
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

test("refreshing progress asks only for progress", async () => {
  // The common press. Sweeping the catalogue too would spend a detail
  // fetch over every active campaign on data that had not moved.
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.click(screen.getByTestId("refresh-progress"));
  await waitFor(() => expect(calls.some(
    (c) => c.url === "/api/campaigns/refresh?what=progress")).toBe(true));
  expect(calls.some((c) => c.url.includes("what=catalogue"))).toBe(false);
});

test("refreshing campaigns asks only for the catalogue", async () => {
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.click(screen.getByTestId("refresh-catalogue"));
  await waitFor(() => expect(calls.some(
    (c) => c.url === "/api/campaigns/refresh?what=catalogue")).toBe(true));
  expect(calls.some((c) => c.url.includes("what=progress"))).toBe(false);
});

test("a refresh in flight locks both buttons", async () => {
  // They share one payload, so letting the second fire mid-flight races
  // two responses into the same setData. The refresh has to be held
  // open to observe it: a mock that resolves at once is already done.
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push({ url });
    await held;
    return { ok: true, status: 200, json: async () => payload };
  }));

  await userEvent.click(screen.getByTestId("refresh-progress"));
  await waitFor(() =>
    expect(screen.getByTestId("refresh-catalogue")).toBeDisabled());
  release();
  await waitFor(() =>
    expect(screen.getByTestId("refresh-catalogue")).not.toBeDisabled());
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

// Superseded in strength by "collected campaigns sink below everything
// still earnable" below, which asserts the full ordering. Kept because
// it pins the narrower promise -- a collected campaign never leads the
// list -- against a future tier shuffle that satisfies one and not the
// other.
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

test("collected campaigns sink below everything still earnable", async () => {
  // Finished business: nothing about it needs acting on, so it must not
  // sit between two campaigns that do. Even a collected one expiring in
  // an hour ranks below an untouched one with a week left.
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "done", name: "All Done",
        status: "collected", endsAt: Date.now() + 3_600_000 },
      { ...payload.campaigns[0], id: "todo", name: "Still To Do",
        status: "untouched", endsAt: Date.now() + 7 * 86_400_000 },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("All Done")).toBeTruthy());
  const cards = screen.getAllByTestId("campaign-card");
  expect(cards[0]?.textContent).toMatch(/Still To Do/);
  expect(cards[1]?.textContent).toMatch(/All Done/);
});

test("collected sinks below scheduled but stays above ended", async () => {
  // Below scheduled: a campaign yet to open is still something to act
  // on, where a collected one never is again. Above ended: the rewards
  // are real and still worth seeing, where an ended campaign's progress
  // is frozen and can never be finished.
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "done", name: "All Done",
        status: "collected", endsAt: Date.now() + 3_600_000 },
      { ...payload.campaigns[0], id: "over", name: "Long Over",
        status: "partial", endsAt: Date.now() - 86_400_000 },
      { ...payload.campaigns[0], id: "later", name: "Not Yet",
        status: "untouched", startsAt: Date.now() + 86_400_000,
        endsAt: Date.now() + 7 * 86_400_000 },
    ],
  };
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("All Done")).toBeTruthy());
  const order = screen.getAllByTestId("campaign-card")
    .map((c) => c.textContent ?? "");
  const at = (name: string) => order.findIndex((t) => t.includes(name));
  expect(at("All Done")).toBeGreaterThan(at("Not Yet"));
  expect(at("All Done")).toBeLessThan(at("Long Over"));
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
  campaignQueue = false,
) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith("/api/subscriptions")) {
      return {
        ok: true, status: 200,
        json: async () => ({ subscriptions, campaignQueue }),
      };
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

// --- campaigns not open yet ---

const withScheduled = () => {
  body = {
    ...payload,
    campaigns: [...payload.campaigns, {
      id: "c3", name: "Gamma Campaign",
      game: { id: "g3", slug: "gamma-game", displayName: "Gamma Game" },
      startsAt: Date.now() + 2 * 86_400_000, endsAt: Date.now() + 9 * 86_400_000,
      drops: [aDrop], status: "untouched", complete: false,
    }],
  };
};

test("a subscription to a campaign not open yet says when its channels come", async () => {
  withScheduled();
  withSubs([asSub({ id: "s3", targetId: "c3", label: "Gamma Campaign" })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscription-scheduled")).toBeTruthy());
  const row = screen.getByTestId("subscription-row");
  expect(row.textContent).toMatch(/opens .*\(in \w+\); channels are added then/);
  expect(row.textContent).not.toMatch(/nobody is streaming/);
});

test("a queued campaign not open yet names its opening time", async () => {
  withScheduled();
  withSubs([asSub({ id: "s3", targetId: "c3", label: "Gamma Campaign",
                    queue: { state: "scheduled", position: 1 } })],
           { pending: false }, true);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscription-queue")).toBeTruthy());
  // The queue badge carries it; a second "scheduled" badge would repeat it.
  expect(screen.queryByTestId("subscription-scheduled")).toBeNull();
  expect(screen.getByTestId("subscription-row").textContent)
    .toMatch(/waits for its campaign to open .*\(in \w+\), then takes its turn/);
});

test("an open campaign's subscription is not marked scheduled", async () => {
  withSubs([asSub()]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  expect(screen.queryByTestId("subscription-scheduled")).toBeNull();
});

// --- the one-at-a-time queue ---

test("the queue switch posts the new setting", async () => {
  withSubs([asSub()]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const toggle = screen.getByRole("switch", { name: /one campaign at a time/i });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  await userEvent.click(toggle);
  await waitFor(() => {
    const post = calls.find((c) => c.url === "/api/subscriptions/queue");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ enabled: true });
  });
});

test("with the queue on, each row shows its place and waiting rows say why", async () => {
  withSubs([
    asSub({ channels: ["beta"], queue: { state: "active", position: 0 } }),
    asSub({ id: "s2", targetId: "c2", label: "Beta Campaign", rank: 1,
            queue: { state: "waiting", position: 1 } }),
    asSub({ id: "s3", targetId: "c3", label: "Gamma Campaign", rank: 2,
            queue: { state: "scheduled", position: 2 } }),
  ], { pending: false }, true);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getAllByTestId("subscription-queue")).toHaveLength(3));
  const toggle = screen.getByRole("switch", { name: /one campaign at a time/i });
  expect((toggle as HTMLInputElement).checked).toBe(true);
  const rows = screen.getAllByTestId("subscription-row");
  expect(within(rows[0]!).getByTestId("subscription-queue").textContent).toMatch(/collecting/i);
  expect(rows[0]!.textContent).toMatch(/watching beta/);
  expect(within(rows[1]!).getByTestId("subscription-queue").textContent).toMatch(/waiting #1/i);
  expect(rows[1]!.textContent).toMatch(/starts when the campaigns above it/i);
  expect(rows[2]!.textContent).toMatch(/not open yet/i);
  expect(rows[2]!.textContent).toMatch(/waits for its campaign to open/i);
});

test("with the queue off, rows carry no queue badge", async () => {
  withSubs([asSub({ queue: null })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  expect(screen.queryByTestId("subscription-queue")).toBeNull();
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

test("the pool size says what it counts", async () => {
  // A bare stepper is a number with no unit: the row must say the thing
  // being counted is channels, or it reads as an unexplained setting.
  withSubs([asSub({ poolSize: 3 })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const row = screen.getByTestId("subscription-row");
  expect(row.textContent).toMatch(/channels/i);
});

test("the pool size explains itself on hover", async () => {
  withSubs([asSub({ poolSize: 3 })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  await userEvent.hover(
    screen.getByRole("textbox", { name: /channels for alpha/i }),
  );
  await waitFor(() => expect(
    screen.getByText(/how many channels/i),
  ).toBeTruthy());
});

test("changing the pool size posts the new size", async () => {
  withSubs([asSub({ poolSize: 3 })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const input = screen.getByRole("textbox", { name: /channels for alpha/i });
  await userEvent.clear(input);
  await userEvent.type(input, "6");
  await userEvent.tab();
  await waitFor(() => {
    const post = calls.find((c) => c.url === "/api/subscriptions/s1/pool-size");
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.init?.body))).toEqual({ poolSize: 6 });
  });
});

test("committing the size it already had posts nothing", async () => {
  // Every commit costs a directory resolve and possibly a restart, so a
  // blur that changed nothing must not spend one.
  withSubs([asSub({ poolSize: 3 })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const input = screen.getByRole("textbox", { name: /channels for alpha/i });
  await userEvent.click(input);
  await userEvent.tab();
  expect(calls.some((c) => c.url.endsWith("/pool-size"))).toBe(false);
});

test("typing digits does not post until the field is committed", async () => {
  // A post per keystroke would resolve the directory for 1, then 16,
  // on the way to typing 6.
  withSubs([asSub({ poolSize: 3 })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const input = screen.getByRole("textbox", { name: /channels for alpha/i });
  await userEvent.clear(input);
  await userEvent.type(input, "6");
  expect(calls.some((c) => c.url.endsWith("/pool-size"))).toBe(false);
});

test("Enter commits the pool size without leaving the field", async () => {
  withSubs([asSub({ poolSize: 3 })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const input = screen.getByRole("textbox", { name: /channels for alpha/i });
  await userEvent.clear(input);
  await userEvent.type(input, "5{Enter}");
  await waitFor(() => expect(calls.some(
    (c) => c.url === "/api/subscriptions/s1/pool-size",
  )).toBe(true));
});

test("an emptied pool size falls back to the one in force", async () => {
  // A blank box is not a request for zero channels, and posting one
  // would be rejected anyway.
  withSubs([asSub({ poolSize: 3 })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const input = screen.getByRole("textbox", { name: /channels for alpha/i });
  await userEvent.clear(input);
  await userEvent.tab();
  expect(calls.some((c) => c.url.endsWith("/pool-size"))).toBe(false);
  await waitFor(() => expect((input as HTMLInputElement).value).toBe("3"));
});

test("the pool size is disabled while a removal is in flight", async () => {
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
  await waitFor(() => expect(
    screen.getByRole("textbox", { name: /channels for alpha/i })
      .hasAttribute("disabled"),
  ).toBe(true));
  release!();
});

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

// --- subscription links ---

test("a subscribed campaign links down to its own card", async () => {
  // The panel lists no drops of its own, so the label is the way to the
  // card that does list them.
  withSubs([asSub()]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const link = within(screen.getByTestId("subscriptions"))
    .getByRole("link", { name: /alpha campaign/i });
  expect(link.getAttribute("href")).toBe("#campaign-c1");
});

test("following the link opens the campaign's drops", async () => {
  // Arriving at a collapsed card shows nothing the panel did not already
  // say, which is the whole reason for the link.
  withSubs([asSub()]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  await userEvent.click(within(screen.getByTestId("subscriptions"))
    .getByRole("link", { name: /alpha campaign/i }));
  const card = screen.getAllByTestId("campaign-card")
    .find((c) => c.textContent?.includes("Alpha Campaign"))!;
  await waitFor(() =>
    expect(within(card).getByText("Crate")).toBeTruthy());
});

test("a subscription whose campaign has gone gets no dead anchor", async () => {
  // The catalogue drops a campaign when it ends, and there is no card
  // here to jump to. Nothing identifies its game either -- the row
  // carries only the campaign id -- so the row goes plain rather than
  // pointing somewhere invented.
  withSubs([asSub({ targetId: "gone", label: "Ended Campaign" })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  expect(within(screen.getByTestId("subscriptions"))
    .queryByRole("link", { name: /ended campaign/i })).toBeNull();
});

test("a game subscription for an unknown game gets no link", async () => {
  // Nothing in the catalogue carries its slug, and a slug guessed from
  // the display name lands on a 404.
  withSubs([asSub({ kind: "game", targetId: "g9", label: "Unlisted Game" })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  expect(within(screen.getByTestId("subscriptions"))
    .queryByRole("link", { name: /unlisted game/i })).toBeNull();
});

test("a game subscription links to that game's directory", async () => {
  withSubs([asSub({
    kind: "game", targetId: "g1", label: "Alpha Game",
  })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const link = within(screen.getByTestId("subscriptions"))
    .getByRole("link", { name: /alpha game/i });
  expect(link.getAttribute("href"))
    .toBe("https://twitch.tv/directory/category/alpha-game");
});

test("resolved channels link to their Twitch profiles", async () => {
  withSubs([asSub({ channels: ["beta", "gamma"] })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const panel = screen.getByTestId("subscriptions");
  expect(within(panel).getByRole("link", { name: "beta" }).getAttribute("href"))
    .toBe("https://twitch.tv/beta");
  expect(within(panel).getByRole("link", { name: "gamma" }).getAttribute("href"))
    .toBe("https://twitch.tv/gamma");
});

test("channel links open in a new tab, away from the miner", async () => {
  // Navigating the control panel away mid-session loses the page state;
  // the profile is a reference, not a destination.
  withSubs([asSub({ channels: ["beta"] })]);
  renderApp(<Drops />);
  await waitFor(() => expect(screen.getByTestId("subscriptions")).toBeTruthy());
  const link = within(screen.getByTestId("subscriptions"))
    .getByRole("link", { name: "beta" });
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toMatch(/noopener/);
});

// --- view filters ---

/** The catalogue as a mix of running, scheduled, ended and collected. */
function mixedPayload() {
  const now = Date.now();
  return {
    ...payload,
    campaigns: [
      { id: "run", name: "Running One",
        game: { id: "g1", slug: "g1", displayName: "Running Game" },
        startsAt: now - 3_600_000, endsAt: now + 86_400_000,
        drops: [aDrop], status: "untouched" },
      { id: "soon", name: "Scheduled One",
        game: { id: "g2", slug: "g2", displayName: "Scheduled Game" },
        startsAt: now + 3_600_000, endsAt: now + 86_400_000,
        drops: [aDrop], status: "untouched" },
      { id: "done", name: "Ended One",
        game: { id: "g3", slug: "g3", displayName: "Ended Game" },
        startsAt: now - 86_400_000, endsAt: now - 3_600_000,
        drops: [aDrop], status: "untouched" },
      { id: "got", name: "Collected One",
        game: { id: "g4", slug: "g4", displayName: "Collected Game" },
        startsAt: now - 3_600_000, endsAt: now + 86_400_000,
        drops: [aDrop], status: "collected" },
    ],
  };
}

async function shownGames(): Promise<string[]> {
  const cards = await screen.findAllByTestId("campaign-card");
  return cards.map((c) =>
    c.querySelector('[data-testid="campaign-game"]')?.textContent ?? "");
}

test("shows every campaign under All", async () => {
  body = mixedPayload();
  renderApp(<Drops />);
  await waitFor(async () => {
    expect(await shownGames()).toHaveLength(4);
  });
});

test("Running now hides scheduled and ended campaigns", async () => {
  body = mixedPayload();
  const user = userEvent.setup();
  renderApp(<Drops />);
  await screen.findAllByTestId("campaign-card");
  await user.click(screen.getByRole("button", { name: "Running now" }));
  await waitFor(async () => {
    const games = await shownGames();
    expect(games).toContain("Running Game");
    expect(games).toContain("Collected Game");
    expect(games).not.toContain("Scheduled Game");
    expect(games).not.toContain("Ended Game");
  });
});

test("Scheduled shows only campaigns that have not opened yet", async () => {
  body = mixedPayload();
  const user = userEvent.setup();
  renderApp(<Drops />);
  await screen.findAllByTestId("campaign-card");
  await user.click(screen.getByRole("button", { name: "Scheduled" }));
  await waitFor(async () => {
    expect(await shownGames()).toEqual(["Scheduled Game"]);
  });
});

test("Unclaimed leaves out what is finished or out of reach", async () => {
  // A collected campaign needs nothing; an ended one can never be
  // finished however much you watch.
  body = mixedPayload();
  const user = userEvent.setup();
  renderApp(<Drops />);
  await screen.findAllByTestId("campaign-card");
  await user.click(screen.getByRole("button", { name: "Unclaimed" }));
  await waitFor(async () => {
    const games = await shownGames();
    expect(games).toContain("Running Game");
    expect(games).toContain("Scheduled Game");
    expect(games).not.toContain("Collected Game");
    expect(games).not.toContain("Ended Game");
  });
});

test("Collected shows only what is finished", async () => {
  // The inverse of Unclaimed: a place to review what has actually been
  // earned, which the other pills all bury or hide.
  body = mixedPayload();
  const user = userEvent.setup();
  renderApp(<Drops />);
  await screen.findAllByTestId("campaign-card");
  await user.click(screen.getByRole("button", { name: "Collected" }));
  await waitFor(async () => {
    const games = await shownGames();
    expect(games).toEqual(["Collected Game"]);
  });
});

test("says the collected view is empty rather than claiming none exist", async () => {
  // "No drop campaigns are running" under Collected would be a claim
  // about the catalogue, when it is only a claim about the filter.
  body = {
    ...payload,
    campaigns: [
      { ...payload.campaigns[0], id: "todo", name: "Still To Do",
        status: "untouched" },
    ],
  };
  const user = userEvent.setup();
  renderApp(<Drops />);
  await screen.findAllByTestId("campaign-card");
  await user.click(screen.getByRole("button", { name: "Collected" }));
  await waitFor(() => {
    expect(screen.getByTestId("campaigns-empty").textContent)
      .toMatch(/nothing collected yet/i);
  });
});

test("the view filter and the search box narrow together", async () => {
  body = mixedPayload();
  const user = userEvent.setup();
  renderApp(<Drops />);
  await screen.findAllByTestId("campaign-card");
  await user.click(screen.getByRole("button", { name: "Running now" }));
  await user.type(screen.getByPlaceholderText(/Campaign, game or drop/), "Collected");
  await waitFor(async () => {
    expect(await shownGames()).toEqual(["Collected Game"]);
  });
});

test("says which view is empty rather than claiming none are running", async () => {
  // "No drop campaigns are running" under the Scheduled pill would be a
  // claim about the catalogue, when it is only a claim about the filter.
  body = { ...payload, campaigns: [mixedPayload().campaigns[0]] };
  const user = userEvent.setup();
  renderApp(<Drops />);
  await screen.findAllByTestId("campaign-card");
  await user.click(screen.getByRole("button", { name: "Scheduled" }));
  await waitFor(() => {
    expect(screen.getByTestId("campaigns-empty").textContent)
      .toMatch(/no campaigns are scheduled/i);
  });
});

test("sorts scheduled campaigns after running ones and before ended", async () => {
  body = mixedPayload();
  renderApp(<Drops />);
  await waitFor(async () => {
    const games = await shownGames();
    expect(games.indexOf("Scheduled Game"))
      .toBeGreaterThan(games.indexOf("Running Game"));
    expect(games.indexOf("Scheduled Game"))
      .toBeLessThan(games.indexOf("Ended Game"));
  });
});

// --- the game on a subscription row ---

test("names the game beside a subscribed campaign", async () => {
  // The panel lists campaign names alone, and plenty read as a version
  // string ("J5 - Temporix Cps") with no clue what game they are for.
  withSubs([asSub()]);
  renderApp(<Drops />);
  const row = await screen.findByTestId("subscription-row");
  await waitFor(() => {
    expect(within(row).getByTestId("subscription-game").textContent)
      .toBe("Alpha Game");
  });
});

test("omits the game when the campaign is no longer in the catalogue", async () => {
  // Nothing to look it up against; a guessed name would be worse than
  // none.
  withSubs([asSub({ targetId: "gone" })]);
  renderApp(<Drops />);
  const row = await screen.findByTestId("subscription-row");
  await waitFor(() => {
    expect(within(row).queryByTestId("subscription-game")).toBeNull();
  });
});

test("does not repeat the game when it is already the label", async () => {
  // A game subscription is labelled with the game, and rendering it
  // twice on one row reads as a rendering fault.
  withSubs([asSub({ kind: "game", targetId: "g1", label: "Alpha Game" })]);
  renderApp(<Drops />);
  const row = await screen.findByTestId("subscription-row");
  await waitFor(() => {
    expect(within(row).queryByTestId("subscription-game")).toBeNull();
  });
});

test("names the game on a game subscription labelled something else", async () => {
  withSubs([asSub({ kind: "game", targetId: "g1", label: "My watchlist" })]);
  renderApp(<Drops />);
  const row = await screen.findByTestId("subscription-row");
  await waitFor(() => {
    expect(within(row).getByTestId("subscription-game").textContent)
      .toBe("Alpha Game");
  });
});

test("the game yields its width to the campaign name, not the reverse", async () => {
  // The bug this exists to prevent: the game was pinned with
  // flexShrink 0 while the label was free to shrink, so on a narrow
  // screen the row collapsed the campaign name to "W..." and kept the
  // game at full width -- showing only the annotation and none of the
  // thing it annotates.
  withSubs([asSub()]);
  renderApp(<Drops />);
  const row = await screen.findByTestId("subscription-row");
  const game = await within(row).findByTestId("subscription-game");
  expect(game.style.flexShrink).not.toBe("0");
});

test("the game is not capped to a share of the row", async () => {
  // The bug this exists to prevent: a maxWidth of 33% truncated long
  // game names on a wide screen with most of the row unused. Width is
  // yielded by shrinking when contested, never by a fixed share.
  withSubs([asSub()]);
  renderApp(<Drops />);
  const row = await screen.findByTestId("subscription-row");
  const game = await within(row).findByTestId("subscription-game");
  expect(game.style.maxWidth).toBe("");
});

test("a jump opens that campaign and scrolls it into view", async () => {
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  renderApp(<Drops jump={{ value: "c1", id: 1 }} />);
  // Crate is c1's only drop, and only an opened card shows it.
  expect(await screen.findByText("Crate")).toBeTruthy();
  await waitFor(() => expect(scroll).toHaveBeenCalled());
  expect((scroll.mock.contexts[0] as Element).id).toBe("campaign-c1");
  scroll.mockRestore();
});

test("a jump clears a filter that would hide its campaign", async () => {
  const { rerender } = renderApp(<Drops />);
  await waitFor(() => expect(screen.getByText("Alpha Campaign")).toBeTruthy());
  await userEvent.type(screen.getByLabelText(/filter/i), "Beta");
  expect(screen.queryByText("Alpha Campaign")).toBeNull();

  rerender(
    <MantineProvider theme={theme} forceColorScheme="dark">
      <Drops jump={{ value: "c1", id: 1 }} />
    </MantineProvider>,
  );
  expect(await screen.findByText("Alpha Campaign")).toBeTruthy();
  expect(screen.getByLabelText(/filter/i)).toHaveValue("");
});
