import { MantineProvider } from "@mantine/core";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { theme } from "../theme.js";
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
  expect(screen.getByTestId("coverage-empty")).toBeInTheDocument();
  // The feed lives behind its own toggle now.
  await userEvent.click(screen.getByTestId("detail-activity-toggle"));
  expect(await screen.findByTestId("activity-empty")).toBeInTheDocument();
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


test("the activity feed is hidden until its toggle is pressed", async () => {
  // The dialog opens on the history view: the feed is the extra thing
  // you ask for, not a fourth block you scroll past every time.
  stubFetch();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  await screen.findByTestId("coverage-empty");
  expect(screen.queryByTestId("activity-empty")).toBeNull();

  await userEvent.click(screen.getByTestId("detail-activity-toggle"));
  expect(await screen.findByTestId("activity-empty")).toBeInTheDocument();
});

test("the feed replaces the history rather than lengthening the dialog", async () => {
  // Appending would leave the dialog exactly as long, which is the
  // problem the toggle exists to solve.
  stubFetch();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  await screen.findByTestId("coverage-empty");

  await userEvent.click(screen.getByTestId("detail-activity-toggle"));
  await screen.findByTestId("activity-empty");
  expect(screen.queryByTestId("coverage-empty")).toBeNull();
  expect(screen.queryByTestId("points-chart-empty")).toBeNull();
  expect(screen.queryByTestId("streams-empty")).toBeNull();
});

test("the range control hides with the history it governs", async () => {
  // The feed is the last 100 events whatever the range says, so offering
  // to narrow it would be a control that does nothing.
  stubFetch();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  await screen.findByTestId("coverage-empty");
  expect(screen.getByTestId("detail-range")).toBeInTheDocument();

  await userEvent.click(screen.getByTestId("detail-activity-toggle"));
  await screen.findByTestId("activity-empty");
  expect(screen.queryByTestId("detail-range")).toBeNull();
});

test("the toggle reports its state to assistive tech", async () => {
  stubFetch();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  const toggle = await screen.findByTestId("detail-activity-toggle");
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "true");
});

test("going back to the history restores the view the range was left on", async () => {
  stubFetch();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  await screen.findByTestId("coverage-empty");
  await userEvent.click(screen.getByRole("radio", { name: "30 days" }));

  const toggle = screen.getByTestId("detail-activity-toggle");
  await userEvent.click(toggle);
  await screen.findByTestId("activity-empty");
  await userEvent.click(toggle);

  await screen.findByTestId("coverage-empty");
  expect(screen.getByRole("radio", { name: "30 days" })).toBeChecked();
});

test("the activity toggle takes the app's accent when it is the active view", async () => {
  // Grey read as "disabled" rather than "on". Purple is what means
  // "current" elsewhere in the app, and is the one strong colour in
  // this row not already spoken for -- red is LIVE, green is a gain.
  stubFetch();
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  const toggle = await screen.findByTestId("detail-activity-toggle");
  // Mantine writes the resolved colour into --button-bg on the element's
  // own style attribute; jsdom does not resolve it any further.
  expect(toggle.getAttribute("style")).toContain("--button-bg: transparent");

  await userEvent.click(toggle);
  expect(toggle.getAttribute("style")).toContain("--button-bg: var(--mantine-color-twitch-filled)");
});

test("the standalone feed is given more height than the inline default", async () => {
  // 260px is right for one block among several; as the whole view it
  // left the feed scrolling in a letterbox with empty dialog beneath.
  stubFetch({ events: [{ ts: Date.now(), type: "GAIN_FOR_CLAIM", message: "+50" }] });
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  await userEvent.click(await screen.findByTestId("detail-activity-toggle"));
  const entry = await screen.findByTestId("activity-entry");
  // ScrollArea.Autosize puts the cap on its outermost wrapper. "100%"
  // rather than a computed height: the flex body above already stops at
  // the modal's max-height, so the feed fills what is left instead of
  // guessing at the header's size and overflowing.
  const capped = entry.closest("[style*='max-height']");
  expect(capped).not.toBeNull();
  expect(capped?.getAttribute("style")).toContain("max-height: 100%");
});

test("an SSE frame for the same channel does not reset the dialog's own state", async () => {
  // The dashboard rebuilds its snapshot on every frame, so this prop is
  // a fresh object several times a minute. Deriving state from it by
  // reference re-ran a render-phase setState for nothing; the range the
  // user picked must survive those frames untouched.
  stubFetch();
  const { rerender } = renderApp(
    <StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />,
  );
  await screen.findByTestId("coverage-empty");
  await userEvent.click(screen.getByRole("radio", { name: "30 days" }));

  // A new object, same channel -- exactly what .find() returns per frame.
  rerender(
    <MantineProvider theme={theme} forceColorScheme="dark">
      <StreamerDetailModal streamer={streamer({ points: 1234 })} opened onClose={() => {}} />
    </MantineProvider>,
  );
  expect(screen.getByRole("radio", { name: "30 days" })).toBeChecked();
});

test("live figures still follow the snapshot while the dialog is open", async () => {
  // The flip side: `shown` must not become the source of truth, or the
  // balance and LIVE clock would freeze the moment the dialog opened.
  stubFetch();
  const { rerender } = renderApp(
    <StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />,
  );
  expect(await screen.findByTestId("detail-balance")).toHaveTextContent("1,000");

  rerender(
    <MantineProvider theme={theme} forceColorScheme="dark">
      <StreamerDetailModal streamer={streamer({ points: 2500 })} opened onClose={() => {}} />
    </MantineProvider>,
  );
  expect(screen.getByTestId("detail-balance")).toHaveTextContent("2,500");
});

test("the activity view lets the feed own the scrolling, not the modal too", async () => {
  // Two scrollbars appeared when the feed overflowed the modal's own
  // `overflow-y: auto` content box. The body becomes a flex column that
  // cannot exceed its max-height, so only the feed scrolls.
  stubFetch({ events: [{ ts: Date.now(), type: "GAIN_FOR_CLAIM", message: "+50" }] });
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  await userEvent.click(await screen.findByTestId("detail-activity-toggle"));
  await screen.findByTestId("activity-entry");
  const body = document.querySelector(".mantine-Modal-body");
  const content = document.querySelector(".mantine-Modal-content");
  expect(body?.className).toContain("bodyActivity");
  expect(content?.className).toContain("contentActivity");
  // The chain must be unbroken: the Stack between body and feed has to
  // shrink too, or the feed keeps its intrinsic height and the overflow
  // comes back as a second bar.
  const stack = body?.querySelector(".mantine-Stack-root") as HTMLElement | null;
  expect(stack?.getAttribute("style")).toContain("min-height: 0");
  expect(stack?.getAttribute("style")).toContain("flex: 1");
});

test("the history view ends with when the channel is usually live", async () => {
  const now = Date.now();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.includes("/schedule")
      ? { since: now - 3 * 7 * 86_400_000, now, spans: [] }
      : {
          series: [], events: [], sessions: [],
          coverage: { live: [], mined: [] }, firstSeen: null, retentionFloor: null,
          gained: null, gainedSince: null,
        }),
  })));
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  expect(await screen.findByTestId("live-schedule")).toHaveTextContent(/last 3 weeks/i);
  expect(screen.getAllByTestId("schedule-cell")).toHaveLength(168);
  const calls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls;
  expect(calls.some(([url]) => url === "/api/streamers/alpha/schedule")).toBe(true);
});

test("while the first history loads, placeholders stand in for it", async () => {
  // Never answers: the dialog stays in its first-load state.
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  const placeholder = await screen.findByTestId("detail-loading");
  expect(placeholder).toHaveAttribute("aria-busy", "true");
  expect(placeholder).toHaveAccessibleName("Loading history");
});

test("a range change keeps the old history on screen, dimmed, until the new one lands", async () => {
  let answer: (() => void) | null = null;
  const body = {
    series: [], events: [], sessions: [],
    coverage: { live: [], mined: [] }, firstSeen: null, retentionFloor: null,
    gained: null, gainedSince: null,
  };
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const reply = { ok: true, status: 200, json: async () => (url.includes("/schedule") ? { since: 0, now: 0, spans: [] } : body) };
    // The first history request answers at once; the next waits.
    if (url.startsWith("/api/history") && answer === null) {
      answer = () => {};
      return Promise.resolve(reply);
    }
    if (url.startsWith("/api/history")) {
      return new Promise((resolve) => { answer = () => resolve(reply); });
    }
    return Promise.resolve(reply);
  }));
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  const history = await screen.findByTestId("detail-history");
  expect(history).toHaveAttribute("aria-busy", "false");

  await userEvent.click(screen.getByText("30 days"));
  await waitFor(() => expect(screen.getByTestId("detail-history")).toHaveAttribute("aria-busy", "true"));
  // Dimmed in place rather than swapped for placeholders: nothing jumps.
  expect(screen.queryByTestId("detail-loading")).toBeNull();
  expect(screen.getByTestId("detail-history").style.opacity).toBe("0.5");

  answer!();
  await waitFor(() => expect(screen.getByTestId("detail-history")).toHaveAttribute("aria-busy", "false"));
});

test("while a new range loads, the gain does not show the old range's figure", async () => {
  let answer: (() => void) | null = null;
  const body = (gained: number) => ({
    series: [], events: [], sessions: [],
    coverage: { live: [], mined: [] }, firstSeen: null, retentionFloor: null,
    gained, gainedSince: null,
  });
  let first = true;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.includes("/schedule")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ since: 0, now: 0, spans: [] }) });
    }
    if (first) {
      first = false;
      return Promise.resolve({ ok: true, status: 200, json: async () => body(700) });
    }
    return new Promise((resolve) => {
      answer = () => resolve({ ok: true, status: 200, json: async () => body(3000) });
    });
  }));
  renderApp(<StreamerDetailModal streamer={streamer()} opened onClose={() => {}} />);
  await waitFor(() => expect(screen.getByTestId("detail-gain")).toHaveTextContent("+700"));

  await userEvent.click(screen.getByText("30 days"));
  // The 7-day figure under a "30 days" label would be a wrong claim.
  await waitFor(() => expect(screen.getByTestId("detail-gain")).not.toHaveTextContent("700"));
  expect(screen.getByTestId("detail-gain")).toHaveTextContent("—");

  answer!();
  await waitFor(() => expect(screen.getByTestId("detail-gain")).toHaveTextContent("+3,000"));
});
