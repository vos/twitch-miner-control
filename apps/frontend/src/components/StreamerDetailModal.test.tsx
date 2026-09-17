import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { StreamerCard } from "./StreamerCard.js";
import { StreamerDetailModal } from "./StreamerDetailModal.js";
import type { StreamerState } from "../api/useLiveState.js";

function streamer(over: Partial<StreamerState> = {}): StreamerState {
  return {
    username: "alpha", displayName: "Alpha", channelId: null, points: 1000,
    isOnline: true, pointsEnabled: true, gained24h: 100, gainedSince: null,
    gainedStream: 50, spark: [1, 2], avatarUrl: null, liveSince: Date.now() - 3600_000,
    streamId: "s1", lastLive: null, lastActivity: null, online24h: 0,
    mined24h: 0, minedTotal: 0, pointsPerHour: null,
    multiplier: null, claimPending: false, watching: false, goal: null,
    game: null, streamTitle: null, viewers: null, drop: null, ...over,
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

function stubFetch(over: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({
      series: [], events: [], sessions: [],
      coverage: { live: [], mined: [] }, firstSeen: null, retentionFloor: null,
      gained: null, gainedSince: null, ...over,
    }),
  })));
}

/** Serves a different gain per requested window, keyed by `from`. */
function stubFetchPerRange(gainForSpan: (spanMs: number) => number) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const from = Number(new URL(url, "http://x").searchParams.get("from"));
    const to = Number(new URL(url, "http://x").searchParams.get("to"));
    return {
      ok: true, status: 200, json: async () => ({
        series: [], events: [], sessions: [],
        coverage: { live: [], mined: [] }, firstSeen: null, retentionFloor: null,
        gained: gainForSpan(to - from), gainedSince: null,
      }),
    };
  }));
}

test("the card calls onOpen when clicked", async () => {
  const onOpen = vi.fn();
  renderApp(<StreamerCard streamer={streamer()} onOpen={onOpen} />);
  await userEvent.click(screen.getByTestId("streamer-alpha"));
  expect(onOpen).toHaveBeenCalled();
});

test("the card opens on Enter, so it is reachable without a mouse", async () => {
  const onOpen = vi.fn();
  renderApp(<StreamerCard streamer={streamer()} onOpen={onOpen} />);
  screen.getByTestId("streamer-alpha").focus();
  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalled();
});

test("clicking the twitch link does not open the dialog", async () => {
  // The name is an anchor to twitch.tv and must keep working; a card-wide
  // handler that swallowed it would break the card's only outbound link.
  const onOpen = vi.fn();
  renderApp(<StreamerCard streamer={streamer()} onOpen={onOpen} />);
  await userEvent.click(screen.getByRole("link", { name: "Alpha" }));
  expect(onOpen).not.toHaveBeenCalled();
});

test("a card without onOpen stays a plain, unfocusable element", () => {
  renderApp(<StreamerCard streamer={streamer()} />);
  const card = screen.getByTestId("streamer-alpha");
  expect(card).not.toHaveAttribute("role");
  expect(card).not.toHaveAttribute("tabindex");
});

test("the dialog names the streamer it is about", async () => {
  stubFetch();
  renderApp(
    <StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />,
  );
  expect(await screen.findByTestId("detail-title")).toHaveTextContent("Alpha");
});

test("the dialog closes on Escape", async () => {
  stubFetch();
  const onClose = vi.fn();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={onClose} />);
  await screen.findByTestId("detail-title");
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalled();
});

test("renders nothing when no streamer is selected", () => {
  renderApp(<StreamerDetailModal streamer={null} opened={false} onClose={() => {}} />);
  expect(screen.queryByTestId("detail-title")).toBeNull();
});

test("shows every block's empty state for a channel with no history", async () => {
  // A channel added yesterday has nothing yet, and that is not an error:
  // each block says so on its own rather than the dialog failing whole.
  stubFetch();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  expect(await screen.findByTestId("points-chart-empty")).toBeInTheDocument();
  expect(screen.getByTestId("streams-empty")).toBeInTheDocument();
  expect(screen.getByTestId("activity-empty")).toBeInTheDocument();
  expect(screen.getByTestId("coverage-empty")).toBeInTheDocument();
  expect(screen.queryByRole("alert", { hidden: true })).toBeNull();
});

test("the balance carries the same coin glyph as the card", async () => {
  // The dialog opens over the card it came from; two renderings of one
  // figure, side by side, would read as two different figures.
  stubFetch();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  const balance = await screen.findByTestId("detail-balance");
  expect(balance).toHaveTextContent("1,000");
  expect(balance.querySelector("svg")).not.toBeNull();
});

test("the gain follows the chosen range instead of always reporting 24h", async () => {
  // The whole point of the range control: with "7 days" selected, a "24h"
  // figure beside it is answering a question nobody asked.
  const DAY = 86_400_000;
  stubFetchPerRange((span) => (span > 2 * DAY ? 700 : 100));

  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  // The dialog opens on "7 days".
  expect(await screen.findByTestId("detail-gain")).toHaveTextContent("+700 7 days");

  await userEvent.click(screen.getByRole("radio", { name: "24h" }));
  await waitFor(() => {
    expect(screen.getByTestId("detail-gain")).toHaveTextContent("+100 24h");
  });
});

test("a window longer than the history reports the span actually covered", async () => {
  // Three days of history under a "7 days" range is a real gain over a
  // real window -- it just is not a week, and must not claim to be.
  const since = Date.now() - 3 * 86_400_000;
  stubFetch({ gained: 250, gainedSince: since });
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  const gain = await screen.findByTestId("detail-gain");
  expect(gain).toHaveTextContent("+250");
  expect(gain).not.toHaveTextContent("7 days");
});

test("the gain stays an em dash when there is no earlier balance", async () => {
  // "+0" would be a confident claim that nothing was earned.
  stubFetch({ gained: null });
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  expect(await screen.findByTestId("detail-gain")).toHaveTextContent("—");
});

test("the dialog's status badge is the same badge as the card's", async () => {
  // The dialog opens over the card it came from, so the two are on
  // screen together. They render one component with one class list --
  // the size difference the screenshot caught came from the pill's
  // height being inherited leading rather than its own, which is now
  // pinned in StatusPill.module.css.
  stubFetch();
  const { unmount } = renderApp(<StreamerCard streamer={streamer()} />);
  const cardPill = screen.getByTestId("live-pill").className;
  unmount();

  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  const title = await screen.findByTestId("detail-title");
  expect(title.querySelector("[data-testid='live-pill']")?.className).toBe(cardPill);
});

test("the activity feed sits below the coverage strip", async () => {
  // Coverage is the block no other view in the app duplicates; the feed
  // is the one thing here a reader scrolls TO rather than past.
  stubFetch();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  await screen.findByTestId("coverage-empty");
  const order = Array.from(
    document.querySelectorAll('[data-testid="coverage-empty"], [data-testid="activity-empty"]'),
  ).map((el) => el.getAttribute("data-testid"));
  expect(order).toEqual(["coverage-empty", "activity-empty"]);
});
