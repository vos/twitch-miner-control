import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { RecapPayload } from "../api/useInsights.js";
import { renderApp } from "../test-utils.js";
import { RecapCard } from "./RecapCard.js";

const at = (day: number) => new Date(2026, 8, day).getTime();
const HOUR = 3_600_000;

const recap = (over: Partial<RecapPayload> = {}): RecapPayload => ({
  period: { kind: "week", from: at(7), to: at(14), partial: false },
  totals: { earned: 48_210, minedMs: 31 * HOUR + 40 * 60_000, streams: 9, uptimePct: 94 },
  previous: { earned: 43_045, minedMs: 28 * HOUR, streams: 8, uptimePct: 96 },
  top: [
    { login: "alpha", displayName: "AlphaTV", avatarUrl: null, earned: 18_400, minedMs: 10 * HOUR },
    { login: "beta", displayName: null, avatarUrl: "https://cdn/b.png", earned: 11_020, minedMs: 8 * HOUR },
  ],
  mostWatched: { login: "delta", displayName: "DeltaLive", avatarUrl: null, earned: 0, minedMs: 12 * HOUR },
  highlights: {
    bestDay: { date: "2026-09-10", earned: 9_880 },
    longestStreak: 5, bonusClaims: 42, raids: 3, dropsClaimed: 0, watchStreakBonuses: 0,
  },
  ...over,
});

test("leads with the period and the three headline figures", () => {
  renderApp(<RecapCard recap={recap()} />);
  const card = screen.getByTestId("recap-card");
  expect(card).toHaveTextContent("WEEK OF SEP 7–13 · 2026");
  expect(screen.getByTestId("recap-earned")).toHaveTextContent("48,210");
  expect(card).toHaveTextContent("31h 40m");
  expect(card).toHaveTextContent("94%");
});

test("compares a finished period with the one before", () => {
  renderApp(<RecapCard recap={recap()} />);
  expect(screen.getByTestId("recap-card")).toHaveTextContent("▲ 12% vs last week");
  expect(screen.getByTestId("recap-card")).toHaveTextContent("▼ 2 pts");
});

test("a partial period makes no comparison", () => {
  renderApp(<RecapCard recap={recap({ period: { kind: "week", from: at(14), to: at(17), partial: true } })} />);
  expect(screen.getByTestId("recap-card")).toHaveTextContent("SO FAR");
  expect(screen.getByTestId("recap-card")).not.toHaveTextContent("vs last week");
});

test("lists the podium and the most watched channel", () => {
  renderApp(<RecapCard recap={recap()} />);
  const top = screen.getByTestId("recap-top");
  expect(top).toHaveTextContent("AlphaTV");
  expect(top).toHaveTextContent("beta"); // no display name: the login
  expect(top).toHaveTextContent("most watched: DeltaLive · 12h");
});

test("zero highlights are left out rather than shown as nothing", () => {
  renderApp(<RecapCard recap={recap()} />);
  const highlights = screen.getByTestId("recap-highlights");
  expect(highlights).toHaveTextContent("Best day Thu · 9,880");
  expect(highlights).toHaveTextContent("42 chests");
  expect(highlights).toHaveTextContent("3 raids");
  expect(highlights).toHaveTextContent("5-day streak");
  expect(highlights).not.toHaveTextContent("drop");
});

test("a period with nothing in it says so", () => {
  renderApp(<RecapCard recap={recap({
    totals: { earned: 0, minedMs: 0, streams: 0, uptimePct: 0 },
    top: [], mostWatched: null, previous: null,
    highlights: {
      bestDay: null, longestStreak: 0, bonusClaims: 0, raids: 0,
      dropsClaimed: 0, watchStreakBonuses: 0,
    },
  })} />);
  expect(screen.getByTestId("recap-empty")).toBeInTheDocument();
});

test("avatars can be captured into a PNG", () => {
  renderApp(<RecapCard recap={recap()} />);
  const img = screen.getByTestId("recap-top").querySelector("img")!;
  // Without it the capture taints its canvas and cannot be exported.
  expect(img.getAttribute("crossorigin")).toBe("anonymous");
});
