import { screen } from "@testing-library/react";
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

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({
      series: [], events: [], sessions: [],
      coverage: { live: [], mined: [] }, firstSeen: null, retentionFloor: null,
    }),
  })));
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
  expect(screen.getAllByTestId("coverage-day")).toHaveLength(7);
  expect(screen.queryByRole("alert", { hidden: true })).toBeNull();
});
