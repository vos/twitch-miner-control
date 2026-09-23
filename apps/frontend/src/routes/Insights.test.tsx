import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderApp } from "../test-utils.js";
import { Insights } from "./Insights.js";

vi.mock("modern-screenshot", () => ({
  domToPng: vi.fn(async () => "data:image/png;base64,AAAA"),
}));

const at = (day: number) => new Date(2026, 8, day).getTime();

const calendar = {
  days: [
    { date: "2026-09-14", earned: 400, minedMs: 0, top: null },
    { date: "2026-09-15", earned: 50, minedMs: 0, top: null },
  ],
  since: "2026-09-14",
  streak: { current: 2, longest: 5 },
};

const recap = (period: string, offset: number) => ({
  period: { kind: period, from: at(14 + 7 * offset), to: at(17), partial: offset === 0 },
  totals: { earned: 490, minedMs: 0, streams: 0, uptimePct: 10 },
  previous: null, top: [], mostWatched: null,
  highlights: {
    bestDay: null, longestStreak: 0, bonusClaims: 0, raids: 0,
    dropsClaimed: 0, watchStreakBonuses: 0,
  },
});

let urls: string[];
beforeEach(() => {
  urls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    const q = new URL(url, "http://x").searchParams;
    return {
      ok: true, status: 200,
      json: async () => (url.startsWith("/api/insights/calendar")
        ? calendar
        : recap(q.get("period")!, Number(q.get("offset")))),
    };
  }));
});
afterEach(() => vi.unstubAllGlobals());

const lastRecapUrl = () => urls.filter((u) => u.startsWith("/api/insights/recap")).at(-1);

test("leads with the streak and a year's earnings", async () => {
  renderApp(<Insights />);
  expect(await screen.findByTestId("insights-streak"))
    .toHaveTextContent("2-day streak · longest 5");
  expect(screen.getByTestId("insights-streak")).toHaveTextContent("450 earned in the last year");
});

test("starts on this week's recap", async () => {
  renderApp(<Insights />);
  expect(await screen.findByTestId("recap-earned")).toHaveTextContent("490");
  expect(lastRecapUrl()).toBe("/api/insights/recap?period=week&offset=0");
});

test("steps back a period, and cannot step into the future", async () => {
  renderApp(<Insights />);
  await screen.findByTestId("recap-card");
  expect(screen.getByTestId("recap-next")).toBeDisabled();
  await userEvent.click(screen.getByTestId("recap-prev"));
  await waitFor(() => expect(lastRecapUrl()).toBe("/api/insights/recap?period=week&offset=-1"));
  expect(screen.getByTestId("recap-next")).not.toBeDisabled();
});

test("switching to month starts from this month", async () => {
  renderApp(<Insights />);
  await screen.findByTestId("recap-card");
  await userEvent.click(screen.getByTestId("recap-prev"));
  await userEvent.click(screen.getByText("Month"));
  await waitFor(() => expect(lastRecapUrl()).toBe("/api/insights/recap?period=month&offset=0"));
});

test("a palette jump picks the period", async () => {
  renderApp(<Insights period={{ value: "month", id: 1 }} />);
  await waitFor(() => expect(lastRecapUrl()).toBe("/api/insights/recap?period=month&offset=0"));
});

test("clicking a calendar day opens that day's week", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 24, 12)); // the week after the 14th-20th
  const { container } = renderApp(<Insights />);
  await waitFor(() => expect(container.querySelector('rect[data-date="2026-09-15"]')).not.toBeNull());
  fireEvent.click(container.querySelector('rect[data-date="2026-09-15"]')!);
  await waitFor(() => expect(lastRecapUrl()).toBe("/api/insights/recap?period=week&offset=-1"));
  vi.useRealTimers();
});

test("export downloads the card as a named PNG", async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  renderApp(<Insights />);
  await screen.findByTestId("recap-card");
  await userEvent.click(screen.getByTestId("recap-export"));
  await waitFor(() => expect(click).toHaveBeenCalled());
  const link = click.mock.contexts[0] as HTMLAnchorElement;
  expect(link.download).toBe("twitch-miner-week-2026-09-14.png");
  click.mockRestore();
});

test("a failed export says so and changes nothing else", async () => {
  const { domToPng } = await import("modern-screenshot");
  vi.mocked(domToPng).mockRejectedValueOnce(new Error("tainted canvas"));
  renderApp(<Insights />);
  await screen.findByTestId("recap-card");
  await userEvent.click(screen.getByTestId("recap-export"));
  expect(await screen.findByTestId("recap-export-error")).toHaveTextContent("Export failed");
  expect(screen.getByTestId("recap-card")).toBeInTheDocument();
});

test("with no history yet it says so instead of an empty calendar", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.startsWith("/api/insights/calendar")
      ? { ...calendar, since: null }
      : recap("week", 0)),
  })));
  renderApp(<Insights />);
  expect(await screen.findByTestId("insights-empty"))
    .toHaveTextContent("Not enough history yet");
});

test("with no streak running it says so rather than counting zero days", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.startsWith("/api/insights/calendar")
      ? { ...calendar, streak: { current: 0, longest: 5 } }
      : recap("week", 0)),
  })));
  renderApp(<Insights />);
  const streak = await screen.findByTestId("insights-streak");
  expect(streak).toHaveTextContent("No streak running · longest 5");
  expect(streak).not.toHaveTextContent("0-day");
});
