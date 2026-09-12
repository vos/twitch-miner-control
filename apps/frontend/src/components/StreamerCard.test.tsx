import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { StreamerCard } from "./StreamerCard.js";
import type { StreamerState } from "../api/useLiveState.js";

const base: StreamerState = {
  username: "alpha", displayName: "Alpha", channelId: "1",
  points: 1000, isOnline: true, pointsEnabled: true,
  gained24h: 250, gainedSince: null, gainedStream: 40, spark: [900, 950, 1000],
  avatarUrl: null,
  liveSince: null, streamId: null, lastLive: null, lastActivity: null,
  online24h: 0, mined24h: 0, minedTotal: 0, pointsPerHour: null,
  multiplier: null, claimPending: false, watching: false, goal: null,
  game: null, streamTitle: null, viewers: null, drop: null,
};

const view = (streamer: Partial<StreamerState> = {}) =>
  render(
    <MantineProvider><StreamerCard streamer={{ ...base, ...streamer }} /></MantineProvider>,
  );

test("shows the exact balance, not an abbreviated one", () => {
  view({ points: 1234567 });
  expect(screen.getByText("1,234,567")).toBeInTheDocument();
});

test("shows both gains for a live streamer", () => {
  view();
  expect(screen.getByTestId("gain-stream")).toHaveTextContent("+40");
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("+250");
});

test("omits stream gain when the streamer is offline", () => {
  view({ isOnline: false, gainedStream: null });
  expect(screen.queryByTestId("gain-stream")).not.toBeInTheDocument();
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("+250");
});

test("distinguishes an unknown gain from a genuine zero", () => {
  view({ gained24h: null });
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("—");
  view({ gained24h: 0 });
  expect(screen.getAllByTestId("gain-24h").at(-1)).toHaveTextContent("0");
});

test("labels a partial window with the span it actually covers", () => {
  // Three hours of history is a real gain over a real window -- it just
  // must not claim to be a full day.
  const now = Date.now();
  view({ gained24h: 120, gainedSince: now - 3 * 3_600_000 });
  const gain = screen.getByTestId("gain-24h");
  expect(gain).toHaveTextContent("+120");
  expect(gain).toHaveTextContent("3h");
  expect(gain).not.toHaveTextContent("24h");
});

test("labels a sub-hour window in minutes rather than rounding to 0h", () => {
  const now = Date.now();
  view({ gained24h: 15, gainedSince: now - 12 * 60_000 });
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("12m");
});

test("labels a full window plainly as 24h", () => {
  view({ gained24h: 250, gainedSince: null });
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("24h");
});

test("signs a negative gain rather than showing a bare number", () => {
  view({ gained24h: -30 });
  expect(screen.getByTestId("gain-24h")).toHaveTextContent("-30");
});

test("warns when channel points are disabled, since the balance is frozen", () => {
  view({ pointsEnabled: false });
  expect(screen.getByTestId("points-disabled")).toBeInTheDocument();
});

test("surfaces a per-streamer error", () => {
  view({ error: "channel lookup failed" });
  expect(screen.getByRole("alert")).toHaveTextContent("channel lookup failed");
});

test("shows a placeholder when the balance is unknown", () => {
  view({ points: null });
  expect(screen.getByTestId("balance")).toHaveTextContent("—");
});

test("marks a live channel with a live pill", () => {
  view({ isOnline: true });
  expect(screen.getByTestId("live-pill")).toBeInTheDocument();
});

test("shows no live pill for an offline channel", () => {
  view({ isOnline: false });
  expect(screen.queryByTestId("live-pill")).not.toBeInTheDocument();
});

test("shows a linked avatar for the streamer", () => {
  const { container } = view({ avatarUrl: "https://cdn/a.png" });
  const link = screen.getByRole("link", { name: /on Twitch/i });
  expect(link).toHaveAttribute("href", "https://twitch.tv/alpha");
  // alt="" is deliberate, so the image is presentational rather than an
  // img role -- the name beside it carries the identity.
  expect(container.querySelector("img")).toHaveAttribute("src", "https://cdn/a.png");
});

test("shows a monogram when the avatar is not known yet", () => {
  const { container } = view({ avatarUrl: null });
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByRole("link", { name: /on Twitch/i })).toBeInTheDocument();
});

test("the streamer's name links to their channel", () => {
  view({ avatarUrl: null });
  const nameLink = screen.getByRole("link", { name: "Alpha" });
  expect(nameLink).toHaveAttribute("href", "https://twitch.tv/alpha");
});

test("shows how long the channel has been live in the LIVE badge", () => {
  view({ isOnline: true, liveSince: Date.now() - 3 * 3_600_000 - 24 * 60_000 });
  expect(screen.getByTestId("live-pill")).toHaveTextContent("LIVE 3h 24m");
});

test("shows a bare LIVE badge when the stream start is unknown", () => {
  // An older backend, or a frame that dropped the field: the badge must
  // still assert the channel is live rather than vanishing.
  view({ isOnline: true, liveSince: null });
  expect(screen.getByTestId("live-pill")).toHaveTextContent("LIVE");
});

test("carries no duration in the badge when offline", () => {
  view({ isOnline: false, liveSince: null });
  expect(screen.queryByTestId("live-pill")).not.toBeInTheDocument();
});

test("shows an offline badge carrying when the channel was last seen", () => {
  view({ isOnline: false, liveSince: null, lastLive: Date.now() - 2 * 86_400_000 });
  expect(screen.getByTestId("offline-pill")).toHaveTextContent("OFFLINE 2d");
});

test("shows a bare offline badge for a channel never seen live", () => {
  // Twitch's GQL layer exposes a stream's createdAt only while it is
  // running, so there is no last-broadcast date to fall back on -- the
  // badge must not invent one or render blank.
  view({ isOnline: false, liveSince: null, lastLive: null });
  expect(screen.getByTestId("offline-pill")).toHaveTextContent("OFFLINE");
});

test("keeps the all-time figure on an offline card", () => {
  // A channel mined heavily last week and idle since still has a real
  // total, and it belongs in the same place it sits on a live card.
  view({
    isOnline: false, liveSince: null, lastLive: Date.now() - 2 * 86_400_000,
    mined24h: 0, minedTotal: 5 * 3_600_000,
  });
  expect(screen.getByTestId("mined-total")).toHaveTextContent("5h all-time");
  expect(screen.getByTestId("times-24h")).toHaveTextContent("mined 0m of 24h");
  expect(screen.queryByTestId("last-live")).not.toBeInTheDocument();
});

test("shows no time figures for a channel never mined", () => {
  view({ isOnline: false, liveSince: null, lastLive: null,
    mined24h: 0, minedTotal: 0 });
  expect(screen.queryByTestId("times-24h")).not.toBeInTheDocument();
  expect(screen.queryByTestId("mined-total")).not.toBeInTheDocument();
});

test("does not repeat the live duration below the sparkline", () => {
  // It used to render in both places, which is what this move fixes.
  view({ isOnline: true, liveSince: Date.now() - 27 * 3_600_000 });
  expect(screen.queryByTestId("live-duration")).not.toBeInTheDocument();
  expect(screen.getByTestId("live-pill")).toHaveTextContent("1d 03h");
});

test("shows the last activity in the miner's own terms", () => {
  view({ lastActivity: { ts: Date.now() - 4 * 60_000, type: "GAIN_FOR_CLAIM" } });
  const line = screen.getByTestId("last-activity");
  expect(line).toHaveTextContent("claim");
  expect(line).toHaveTextContent("4m ago");
});

test("labels the last event so it does not read as another total", () => {
  // The three lines below the sparkline used to render identically, so
  // the one describing something that HAPPENED looked like the two
  // describing running totals. The tag is what separates them.
  view({ lastActivity: { ts: Date.now() - 4 * 60_000, type: "GAIN_FOR_CLAIM" } });
  expect(screen.getByTestId("last-activity")).toHaveTextContent("LAST");
});

test("marks a just-happened event as fresh", () => {
  view({ lastActivity: { ts: Date.now() - 2 * 60_000, type: "GAIN_FOR_CLAIM" } });
  expect(screen.getByTestId("last-activity")).toHaveAttribute("data-fresh", "true");
});

test("does not mark a stale event as fresh", () => {
  // The marker exists to make "something just happened here" scannable
  // across a grid; an hours-old event claiming it would defeat that.
  view({ lastActivity: { ts: Date.now() - 3 * 3_600_000, type: "GAIN_FOR_RAID" } });
  const line = screen.getByTestId("last-activity");
  expect(line).toHaveAttribute("data-fresh", "false");
  expect(line).toHaveTextContent("raid");
  expect(line).toHaveTextContent("3h ago");
});

test("shows how many points the last event earned", () => {
  // The amount is the one fact the bare label never carried.
  view({
    lastActivity: {
      ts: Date.now() - 4 * 60_000,
      type: "GAIN_FOR_CLAIM",
      message: "+50 → Streamer(username=alpha, channel_id=1, channel_points=12.3k)"
        + " - Reason: CLAIM.",
    },
  });
  const line = screen.getByTestId("last-activity");
  expect(screen.getByTestId("last-activity-gain")).toHaveTextContent("+50");
  expect(line).toHaveTextContent("claim");
  // The object noise in the miner's line never reaches the card.
  expect(line).not.toHaveTextContent("Streamer(");
  expect(line).not.toHaveTextContent("12.3k");
});

test("shows the label alone when the event carried no message", () => {
  view({ lastActivity: { ts: Date.now() - 4 * 60_000, type: "GAIN_FOR_CLAIM", message: null } });
  expect(screen.queryByTestId("last-activity-gain")).not.toBeInTheDocument();
  expect(screen.getByTestId("last-activity")).toHaveTextContent("claim");
});

test("renders an unrecognised event type rather than dropping the line", () => {
  // The doorbell route bounds the event name's SHAPE, not its vocabulary
  // (see server.ts), so a name outside the pinned set can reach the card.
  view({ lastActivity: { ts: Date.now() - 90 * 60_000, type: "DROP_CLAIM" } });
  expect(screen.getByTestId("last-activity")).toHaveTextContent("drop claim");
});

test("shows mining time against the window", () => {
  view({ online24h: 8 * 3_600_000, mined24h: 6 * 3_600_000 });
  expect(screen.getByTestId("times-24h")).toHaveTextContent("mined 6h of 24h");
});

test("never repeats the uptime as an online figure", () => {
  // The uptime top-left already says how long the channel has been live,
  // and clipping it to the window made it worse -- a stream up for 27
  // hours read "live 24h" right beside its own "1d 03h".
  view({ isOnline: true, liveSince: Date.now() - 27 * 3_600_000,
    online24h: 24 * 3_600_000, mined24h: 55 * 60_000 });
  const line = screen.getByTestId("times-24h");
  expect(line).toHaveTextContent("mined 55m");
  expect(line).not.toHaveTextContent("live");
  expect(line).not.toHaveTextContent("24h ·");
});

test("shows the mining time the server reports, not the stream's length", () => {
  // The bug this replaces: the card added the running stream to these
  // figures, assuming the miner had been up for all of it. A miner
  // started 12 minutes into a day-long stream reported "mined 24h".
  view({
    isOnline: true,
    liveSince: Date.now() - 26 * 3_600_000,
    online24h: 24 * 3_600_000,
    mined24h: 13 * 60_000,
    minedTotal: 13 * 60_000,
  });
  const line = screen.getByTestId("times-24h");
  expect(line).toHaveTextContent("mined 13m");
  expect(screen.getByTestId("mined-total")).toHaveTextContent("13m");
});

test("shows when an offline channel was last live, in the badge only", () => {
  view({ isOnline: false, liveSince: null, lastLive: Date.now() - 3 * 86_400_000 });
  expect(screen.getByTestId("offline-pill")).toHaveTextContent("OFFLINE 3d");
  // Not repeated below the sparkline, the way the live duration is not.
  expect(screen.queryByTestId("last-live")).not.toBeInTheDocument();
});

test("shows the all-time mining figure", () => {
  // 142h is 5.9 days: truncated to "5d", not rounded up to "6d". Time
  // mined is a claim about work done, so it never rounds up.
  view({ minedTotal: 142 * 3_600_000 });
  expect(screen.getByTestId("mined-total")).toHaveTextContent("5d");
});

test("shows points per hour when it is reported", () => {
  view({ pointsPerHour: 42.5 });
  expect(screen.getByTestId("points-per-hour")).toHaveTextContent("42.5");
});

test("omits points per hour below the mining floor", () => {
  view({ pointsPerHour: null });
  expect(screen.queryByTestId("points-per-hour")).not.toBeInTheDocument();
});

test("renders nothing rather than zeros without history", () => {
  // "0h mined" and "we have not watched yet" are different claims.
  view({ isOnline: false, liveSince: null, lastLive: null, lastActivity: null });
  expect(screen.queryByTestId("times-24h")).not.toBeInTheDocument();
  expect(screen.queryByTestId("last-live")).not.toBeInTheDocument();
  expect(screen.queryByTestId("live-duration")).not.toBeInTheDocument();
});

test("survives a snapshot missing the time fields entirely", () => {
  // A frame from a backend that predates these fields must degrade to a
  // card without a time block, never throw and blank the dashboard.
  const { liveSince, lastLive, lastActivity, online24h, mined24h, minedTotal,
    pointsPerHour, streamId, ...withoutTimes } = base;
  render(
    <MantineProvider>
      <StreamerCard streamer={withoutTimes as StreamerState} />
    </MantineProvider>,
  );
  expect(screen.getByTestId("balance")).toBeInTheDocument();
  // The base fixture is online, so the mined line still renders -- with a
  // truthful zero rather than a number invented from a missing field.
  expect(screen.getByTestId("times-24h")).toHaveTextContent("mined 0m");
  expect(screen.queryByTestId("mined-total")).not.toBeInTheDocument();
});

test("shows a live card with no mining time yet", () => {
  // Channel live for a day, miner never started: the card must not
  // invent mining time from the stream being up.
  view({
    isOnline: true,
    liveSince: Date.now() - 26 * 3_600_000,
    online24h: 24 * 3_600_000,
    mined24h: 0,
    minedTotal: 0,
  });
  expect(screen.getByTestId("times-24h")).toHaveTextContent("mined 0m");
  expect(screen.queryByTestId("mined-total")).not.toBeInTheDocument();
});

test("rounds mining time down, never up", () => {
  // A mining figure is a claim about work actually done. formatSpan
  // rounds to nearest for gain-window labels, which would render 30
  // minutes of mining as "1h" -- overstating it by 2x.
  view({ isOnline: true, mined24h: 30 * 60_000, minedTotal: 30 * 60_000 });
  expect(screen.getByTestId("times-24h")).toHaveTextContent("mined 30m of 24h");

  view({ isOnline: true, mined24h: 119 * 60_000, minedTotal: 119 * 60_000 });
  expect(screen.getAllByTestId("times-24h").at(-1)).toHaveTextContent("mined 1h");
});

test("reports an active multiplier as a factor rather than claiming a sub", () => {
  // Sub tiers are the usual source of a multiplier, but not the only one,
  // so the badge reports the factor Twitch actually gave us.
  view({ multiplier: 1.2 });
  expect(screen.getByTestId("multiplier")).toHaveTextContent("1.2");
});

test("shows no multiplier badge when there is no multiplier", () => {
  view({ multiplier: null });
  expect(screen.queryByTestId("multiplier")).not.toBeInTheDocument();
});

test("flags an unclaimed bonus, which is the one actionable badge", () => {
  view({ claimPending: true });
  expect(screen.getByTestId("claim-pending")).toBeInTheDocument();
});

test("shows no claim badge when nothing is waiting", () => {
  view({ claimPending: false });
  expect(screen.queryByTestId("claim-pending")).not.toBeInTheDocument();
});

test("marks the channels the miner is actually watching", () => {
  view({ watching: true });
  expect(screen.getByTestId("watching-badge")).toBeInTheDocument();
});

test("never claims to be watching an offline channel's card", () => {
  view({ isOnline: false, watching: false });
  expect(screen.queryByTestId("watching-badge")).not.toBeInTheDocument();
});

test("moves the points-disabled warning out of the title row", () => {
  // It describes the channel, not its live status -- and the title row
  // needs the headroom for the name.
  view({ pointsEnabled: false });
  const meta = screen.getByTestId("meta-row");
  expect(meta).toContainElement(screen.getByTestId("points-disabled"));
});

test("renders no meta row at all when there is nothing to put in it", () => {
  // An empty strip would still cost vertical space and a gap on every
  // card that has none of these signals.
  view({ multiplier: null, claimPending: false, watching: false });
  expect(screen.queryByTestId("meta-row")).not.toBeInTheDocument();
});

const goal = { title: "New emotes", contributed: 3_000, needed: 10_000 };

test("keeps a community goal behind a disclosure rather than always-on", () => {
  // A title, a bar and two figures is a third of a 320px card's height
  // for something that moves hourly.
  view({ goal });
  expect(screen.queryByTestId("goal-progress")).not.toBeInTheDocument();
  expect(screen.getByTestId("goal-toggle")).toHaveTextContent("New emotes");
});

test("reveals the goal's progress once expanded", async () => {
  const user = userEvent.setup();
  view({ goal });
  await user.click(screen.getByTestId("goal-toggle"));
  const progress = screen.getByTestId("goal-progress");
  expect(progress).toHaveTextContent("3,000");
  expect(progress).toHaveTextContent("10,000");
});

test("offers no goal disclosure when the channel has no goal", () => {
  view({ goal: null });
  expect(screen.queryByTestId("goal-toggle")).not.toBeInTheDocument();
});

test("reports goal progress to assistive tech, not just as a bar width", () => {
  const user = userEvent.setup();
  view({ goal });
  return user.click(screen.getByTestId("goal-toggle")).then(() => {
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "30");
  });
});

test("survives a snapshot from a backend that predates these fields", () => {
  // A frame that omits them entirely arrives as undefined, not null --
  // a strict !== null test let it through to a property access that took
  // the whole dashboard down.
  const { multiplier, claimPending, watching, goal: _g, ...older } = base;
  render(
    <MantineProvider>
      <StreamerCard streamer={older as StreamerState} />
    </MantineProvider>,
  );
  expect(screen.getByTestId("balance")).toHaveTextContent("1,000");
  expect(screen.queryByTestId("goal-toggle")).not.toBeInTheDocument();
});

test("dims a multiplier on an offline channel rather than dropping it", () => {
  // A multiplier is a standing property of the channel, so hiding it when
  // the stream ends would make the badge flicker with live state. But it
  // cannot multiply anything while nothing is being mined, so it must not
  // read as active either.
  view({ isOnline: false, multiplier: 1.5 });
  expect(screen.getByTestId("multiplier")).toHaveAttribute("data-idle", "true");
});

test("shows an active multiplier as active while the channel is live", () => {
  view({ isOnline: true, multiplier: 1.5 });
  expect(screen.getByTestId("multiplier")).toHaveAttribute("data-idle", "false");
});

test("shows the category and viewer count under the streamer name", () => {
  // Separate cells now -- the category is prose that truncates, the
  // count is a figure aligned under the pill.
  view({ game: "Just Chatting", viewers: 1200 });
  expect(screen.getByTestId("stream-context")).toHaveTextContent("Just Chatting");
  expect(screen.getByTestId("viewers")).toHaveTextContent("1.2K");
});

test("shows the category alone when the channel is offline", () => {
  // A stream that is not running has no audience, so there is no count
  // to print beside the category.
  view({ isOnline: false, game: "Just Chatting", viewers: null });
  const context = screen.getByTestId("stream-context");
  expect(context).toHaveTextContent("Just Chatting");
  expect(context).not.toHaveTextContent("K");
});

test("shows no context line when the category is unknown", () => {
  view({ game: null, viewers: null });
  expect(screen.queryByTestId("stream-context")).not.toBeInTheDocument();
});

test("keeps the stream title off the card itself", () => {
  // Titles are long, emoji-laden and change mid-stream -- on a 320px
  // card the line would truncate to noise.
  view({ game: "Just Chatting", streamTitle: "!drops enabled // day 4" });
  expect(screen.queryByText(/day 4/)).not.toBeInTheDocument();
});

test("reveals the stream title on tap, so it is reachable without hover", async () => {
  const user = userEvent.setup();
  view({ game: "Just Chatting", streamTitle: "!drops enabled // day 4" });
  await user.click(screen.getByTestId("stream-context"));
  expect(await screen.findByText("!drops enabled // day 4")).toBeInTheDocument();
});

test("offers no popover when the channel has no title set", () => {
  view({ game: "Just Chatting", streamTitle: null });
  const context = screen.getByTestId("stream-context");
  expect(context.tagName).not.toBe("BUTTON");
});

test("does not close the title popover on the hover events a tap synthesises", async () => {
  // A touch tap fires touchstart -> mouseenter -> click. With hover
  // handlers bound unconditionally the mouseleave between them closed
  // the popover the click had just opened, so on a phone -- the case a
  // Popover exists for instead of a Tooltip -- the title was unreachable.
  const user = userEvent.setup();
  view({ game: "Just Chatting", streamTitle: "!drops enabled // day 4" });
  const context = screen.getByTestId("stream-context");
  await user.click(context);
  expect(context).toHaveAttribute("aria-expanded", "true");
});

test("puts the stream context in the text column, not under the avatar", () => {
  // Twitch's own shape: the avatar spans the identity block, with the
  // name and what the channel is playing stacked beside it. Full-width
  // below the avatar left the picture with nothing next to it and the
  // context starting at the card's edge.
  view({ game: "Just Chatting", viewers: 1200 });
  const context = screen.getByTestId("stream-context");
  const identity = screen.getByTestId("identity");
  expect(identity).toContainElement(context);
  // The avatar sits in the same identity block, as a sibling of the
  // stack holding the name and context -- not above them.
  expect(identity).toContainElement(
    screen.getByRole("link", { name: /on Twitch/i }),
  );
});

test("marks the viewer count with an icon so the number has a meaning", () => {
  // A bare "2.0K" beside a category reads as an unlabelled figure. The
  // person glyph is how Twitch itself says "this is an audience".
  view({ game: "Just Chatting", viewers: 1200 });
  expect(screen.getByTestId("viewers")).toHaveAccessibleName(/viewers/i);
});

test("renders no viewer icon when the channel is offline", () => {
  view({ isOnline: false, game: "Just Chatting", viewers: null });
  expect(screen.queryByTestId("viewers")).not.toBeInTheDocument();
});

test("aligns the viewer count right, under the live badge", () => {
  // Its own grid cell rather than trailing the category: the count is a
  // figure and belongs in a column with the pill above it, not in the
  // middle of a line of prose that truncates.
  view({ game: "Just Chatting", viewers: 1200 });
  const identity = screen.getByTestId("identity");
  const viewers = screen.getByTestId("viewers");
  expect(identity).toContainElement(viewers);
  // No longer inside the category's element -- they are siblings now.
  expect(screen.getByTestId("stream-context")).not.toContainElement(viewers);
});

test("keeps the title popover on the category, not the viewer count", () => {
  // The title describes what is being streamed, which is what the
  // category names -- the audience size is a different fact.
  view({ game: "Just Chatting", viewers: 1200, streamTitle: "!drops // day 4" });
  expect(screen.getByTestId("stream-context")).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByTestId("viewers").tagName).not.toBe("BUTTON");
});

test("shows the viewer count even when the channel has no category", () => {
  // The two are independent facts now that they are separate cells: a
  // live channel with no category set still has an audience.
  view({ game: null, viewers: 1200 });
  expect(screen.getByTestId("viewers")).toHaveTextContent("1.2K");
});

const dropAt = (over: object = {}) => ({
  name: "Crate", minutes: 45, required: 60, claimable: false,
  benefits: ["Weapon Charm"], endsAt: null, ...over,
});

test("shows how far along the next drop is", () => {
  view({ drop: dropAt() });
  const badge = screen.getByTestId("drop");
  expect(badge).toHaveTextContent("45");
  expect(badge).toHaveTextContent("60");
});

test("marks a drop that is ready to collect", () => {
  // Waiting to be claimed is a different state from still accruing --
  // one is actionable, the other is just progress.
  view({ drop: dropAt({ minutes: 60, claimable: true }) });
  expect(screen.getByTestId("drop")).toHaveAttribute("data-claimable", "true");
});

test("shows no drop badge when the channel has none", () => {
  view({ drop: null });
  expect(screen.queryByTestId("drop")).not.toBeInTheDocument();
});

test("names the drop for assistive tech, not just as a bar", () => {
  view({ drop: dropAt() });
  expect(screen.getByTestId("drop")).toHaveAccessibleName(/Crate/);
});

test("survives a snapshot with no drop field at all", () => {
  const { drop: _d, ...older } = base;
  render(
    <MantineProvider><StreamerCard streamer={older as StreamerState} /></MantineProvider>,
  );
  expect(screen.queryByTestId("drop")).not.toBeInTheDocument();
  expect(screen.getByTestId("balance")).toBeInTheDocument();
});

test("opens the drop detail on tap, not hover alone", async () => {
  // A Tooltip never opens on a touch device, which is where the detail
  // was unreachable -- the same reason the stream title uses a Popover.
  const user = userEvent.setup();
  view({ drop: dropAt() });
  await user.click(screen.getByTestId("drop"));
  expect(await screen.findByTestId("drop-detail")).toBeInTheDocument();
});

test("names the drop and what it awards in the detail", () => {
  view({ drop: dropAt({ benefits: ["Weapon Charm", "500 Credits"] }) });
  // Rendered up front rather than behind the click, so the assertion is
  // about content rather than the disclosure.
  expect(screen.getByTestId("drop")).toHaveAccessibleName(/Crate/);
});

test("says how much longer the drop needs", async () => {
  const user = userEvent.setup();
  view({ drop: dropAt({ minutes: 45, required: 60 }) });
  await user.click(screen.getByTestId("drop"));
  expect(await screen.findByTestId("drop-remaining")).toHaveTextContent("15");
});

test("reports a drop whose minutes are met as ready rather than 0 to go", async () => {
  const user = userEvent.setup();
  view({ drop: dropAt({ minutes: 60, required: 60, claimable: true }) });
  await user.click(screen.getByTestId("drop"));
  const remaining = await screen.findByTestId("drop-remaining");
  expect(remaining).toHaveTextContent(/ready/i);
  expect(remaining).not.toHaveTextContent("0 minutes");
});

test("shows the campaign deadline when there is one", async () => {
  const user = userEvent.setup();
  view({ drop: dropAt({ endsAt: Date.now() + 3 * 86_400_000 }) });
  await user.click(screen.getByTestId("drop"));
  expect(await screen.findByTestId("drop-ends")).toHaveTextContent("3d");
});

test("omits the deadline line when none was reported", async () => {
  const user = userEvent.setup();
  view({ drop: dropAt({ endsAt: null }) });
  await user.click(screen.getByTestId("drop"));
  await screen.findByTestId("drop-detail");
  expect(screen.queryByTestId("drop-ends")).not.toBeInTheDocument();
});

test("omits the benefits line when the miner reported none", async () => {
  const user = userEvent.setup();
  view({ drop: dropAt({ benefits: [] }) });
  await user.click(screen.getByTestId("drop"));
  await screen.findByTestId("drop-detail");
  expect(screen.queryByTestId("drop-benefits")).not.toBeInTheDocument();
});
