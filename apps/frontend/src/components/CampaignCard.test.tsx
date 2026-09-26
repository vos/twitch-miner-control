import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import {
  CampaignCard, milestones, watchTime, type ResolvedCampaign,
} from "./CampaignCard.js";
import type { ResolvedDrop } from "./DropTile.js";
import { renderApp } from "../test-utils.js";

const campaign = (over: Partial<ResolvedCampaign> = {}): ResolvedCampaign => ({
  id: "c1",
  name: "Campaign One",
  game: { id: "g1", slug: "a-game", displayName: "A Game" },
  startsAt: 1_000,
  endsAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
  status: "untouched",
  complete: false,
  drops: [
    { id: "d1", name: "Crate",
      benefits: [{ name: "Crate", imageUrl: "https://cdn/crate.png" }],
      requiredMinutes: 60, minutes: 0, status: "not-started" },
  ],
  ...over,
});

test("shows the campaign name and its game", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.getByText("Campaign One")).toBeTruthy();
  expect(screen.getByText("A Game")).toBeTruthy();
});

test("a campaign with no game falls back to its own name as the title", () => {
  // The card leads with the game, so a campaign without one would
  // otherwise render an empty heading above its box art.
  renderApp(<CampaignCard campaign={campaign({ game: null })} />);
  expect(screen.getByTestId("campaign-game").textContent).toBe("Campaign One");
});

test("reports how long the campaign has left", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  // "3d left", matching the tracker's own phrasing: the card is scanned
  // for how long is left, and the shorter form fits the grid's width.
  expect(screen.getByTestId("campaign-ends").textContent).toMatch(/3d left/i);
});

test("a campaign already over says so rather than counting backwards", () => {
  renderApp(
    <CampaignCard campaign={campaign({ endsAt: Date.now() - 60_000 })} />,
  );
  expect(screen.getByTestId("campaign-ends").textContent).toMatch(/ended/i);
});

test("a campaign with no end date reported shows no deadline", () => {
  renderApp(<CampaignCard campaign={campaign({ endsAt: null })} />);
  expect(screen.queryByTestId("campaign-ends")).toBeNull();
});

test("shows the collection verdict", () => {
  renderApp(<CampaignCard campaign={campaign({ status: "collected" })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/collected/i);
});

test("an unknown verdict is not rendered as untouched", () => {
  // Reporting "untouched" when we could not read the inventory would be
  // a confident claim about progress we do not have.
  renderApp(<CampaignCard campaign={campaign({ status: "unknown" })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/unknown/i);
});

test("drops are hidden until the card is expanded", async () => {
  // The list runs long; every campaign open at once is unreadable. The
  // drops are genuinely unmounted while collapsed (keepMounted={false}),
  // not merely hidden, so a screen reader does not walk a hundred of
  // them -- which is also why the expansion has to be awaited: the
  // content mounts with the enter transition rather than synchronously.
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.queryByTestId("drop-row")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /campaign one, 1 drop/i }));
  await waitFor(() => expect(screen.getByTestId("drop-row")).toBeTruthy());
});

test("says how many drops a campaign has without expanding it", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.getByTestId("campaign-drop-count").textContent).toMatch(/1 drop/i);
});

test("an ended campaign with no progress says ended, not not-started", () => {
  // "NOT STARTED" on a campaign that is over reads as an invitation to
  // start something that cannot be started.
  renderApp(<CampaignCard campaign={campaign({
    status: "untouched", endsAt: Date.now() - 86_400_000,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/ended/i);
});

test("an ended campaign with partial progress also says ended", () => {
  // The progress is frozen and can never be finished, so "in progress"
  // would claim something is happening that is not.
  renderApp(<CampaignCard campaign={campaign({
    status: "partial", endsAt: Date.now() - 86_400_000,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/ended/i);
});

test("an ended campaign that was collected still says collected", () => {
  // A real achievement, and the deadline passing does not undo it.
  renderApp(<CampaignCard campaign={campaign({
    status: "collected", endsAt: Date.now() - 86_400_000,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/collected/i);
});

test("a live campaign keeps its collection state", () => {
  renderApp(<CampaignCard campaign={campaign({
    status: "untouched", endsAt: Date.now() + 86_400_000,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/not started/i);
});

test("a campaign with no end date never reports itself ended", () => {
  // Unknown deadline is not a passed one.
  renderApp(<CampaignCard campaign={campaign({
    status: "untouched", endsAt: null,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/not started/i);
});

test("an ended campaign whose progress is unknown says ended", () => {
  renderApp(<CampaignCard campaign={campaign({
    status: "unknown", endsAt: Date.now() - 86_400_000,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/ended/i);
});

test("shows an inline notice on the row while it is working", () => {
  // On the row, so the feedback cannot be mistaken for another
  // campaign's.
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={() => {}}
                          busy="Finding channels…" />);
  expect(screen.getByTestId("campaign-busy").textContent)
    .toMatch(/finding channels/i);
});

test("no notice when the card is idle", () => {
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={() => {}} />);
  expect(screen.queryByTestId("campaign-busy")).toBeNull();
});

test("the button itself shows it is working", () => {
  // The button is what was clicked; leaving it inert while a notice
  // appears elsewhere reads as the click not registering.
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={() => {}}
                          busy="Finding channels…" />);
  const btn = screen.getByRole("button", { name: /subscribe/i });
  expect(btn.getAttribute("data-loading")).toBe("true");
});

test("a busy card cannot be clicked again", async () => {
  // A second subscribe while the first is in flight would race. Asserted
  // on the effect rather than the attribute: Mantine sets the native
  // `disabled`, not data-disabled.
  const onSubscribe = vi.fn();
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={onSubscribe}
                          busy="Finding channels…" />);
  await userEvent.click(screen.getByRole("button", { name: /subscribe/i }));
  expect(onSubscribe).not.toHaveBeenCalled();
});

test.each([
  ["ended", { endsAt: Date.now() - 1_000 }, /has ended/i],
  ["complete", { complete: true }, /already earned/i],
])("an %s campaign cannot be subscribed to, and says why", async (_n, over, why) => {
  const onSubscribe = vi.fn();
  renderApp(<CampaignCard campaign={campaign(over)} onSubscribe={onSubscribe} />);
  const btn = screen.getByRole("button", { name: /subscribe/i });
  expect(btn.getAttribute("aria-disabled")).toBe("true");
  await userEvent.click(btn);
  expect(onSubscribe).not.toHaveBeenCalled();
  await userEvent.hover(btn);
  expect(await screen.findByText(why)).toBeTruthy();
});

test("a finished campaign can still be unsubscribed from", async () => {
  const onUnsubscribe = vi.fn();
  renderApp(<CampaignCard campaign={campaign({ complete: true })} subscribed
                          onSubscribe={() => {}} onUnsubscribe={onUnsubscribe} />);
  await userEvent.click(screen.getByRole("button", { name: /unsubscribe/i }));
  expect(onUnsubscribe).toHaveBeenCalledTimes(1);
});

test("carries an id so a link elsewhere on the page can reach it", () => {
  // The subscriptions panel links its rows down to the card, which needs
  // a stable anchor rather than a position in a list that re-sorts.
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.getByTestId("campaign-card").id).toBe("campaign-c1");
});

// --- box art, rewards and the two bars ---

test("shows the game's box art, asking the CDN for the size it draws", () => {
  // The source serves 285x380 by default; the card draws ~88px wide, so
  // the untouched URL would be several times the pixels needed on every
  // one of a hundred cards.
  renderApp(<CampaignCard campaign={campaign({
    game: {
      id: "g1", slug: "a-game", displayName: "A Game",
      boxArtUrl: "https://cdn/ttv-boxart/g1_IGDB-285x380.jpg",
    },
  })} />);
  const art = screen.getByTestId("box-art") as HTMLImageElement;
  expect(art.src).toBe("https://cdn/ttv-boxart/g1_IGDB-176x234.jpg");
});

test("falls back to a letter tile when the game has no box art", () => {
  renderApp(<CampaignCard campaign={campaign({
    game: { id: "g1", slug: "a-game", displayName: "A Game" },
  })} />);
  expect(screen.queryByTestId("box-art")).toBeNull();
  expect(screen.getByTestId("box-art-fallback").textContent).toBe("A");
});

test("leads with the game and demotes the campaign to a subtitle", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.getByTestId("campaign-game").textContent).toBe("A Game");
  expect(screen.getByTestId("campaign-name").textContent).toBe("Campaign One");
});

test("names the campaign owner when the source reported one", () => {
  renderApp(<CampaignCard campaign={campaign({
    owner: { name: "Starry", type: "Organization" },
  })} />);
  expect(screen.getByTestId("campaign-owner").textContent).toBe("Starry");
});

test("falls back to the drop count when no owner is reported", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.getByTestId("campaign-owner").textContent).toBe("1 drop");
});

test("shows a reward icon for each drop on the collapsed card", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(screen.getAllByTestId("reward-icon")).toHaveLength(1);
  expect(screen.queryByTestId("reward-overflow")).toBeNull();
});

test("caps the reward strip and counts the rest", () => {
  // A ten-drop campaign must not set its card taller than the ones
  // beside it in the grid.
  const drops = Array.from({ length: 8 }, (_, i) => ({
    id: `d${i}`,
    name: `Drop ${i}`,
    benefits: [{ name: `Reward ${i}`, imageUrl: `https://cdn/${i}.png` }],
    requiredMinutes: 60,
    minutes: 0,
    status: "not-started" as const,
  }));
  renderApp(<CampaignCard campaign={campaign({ drops })} />);
  expect(screen.getAllByTestId("reward-icon")).toHaveLength(5);
  expect(screen.getByTestId("reward-overflow").textContent).toBe("+3");
});

test("a drop with no benefit listed still contributes an icon", () => {
  // It awards something; the drop's own name is the only label for it.
  renderApp(<CampaignCard campaign={campaign({
    drops: [{
      id: "d1", name: "Mystery", benefits: [],
      requiredMinutes: 60, minutes: 0, status: "not-started",
    }],
  })} />);
  expect(screen.getByTestId("reward-placeholder")).toBeTruthy();
});

test("the progress bar counts claimed drops against obtainable ones", () => {
  renderApp(<CampaignCard campaign={campaign({
    status: "partial",
    drops: [
      { id: "d1", name: "A", benefits: [], requiredMinutes: 60, minutes: 60,
        status: "claimed" },
      { id: "d2", name: "B", benefits: [], requiredMinutes: 60, minutes: 0,
        status: "not-started" },
    ],
  })} />);
  // On the Progress.Root, which is what carries the label now that the
  // bar is built from stacked sections.
  expect(screen.getByTestId("campaign-progress").getAttribute("aria-label"))
    .toMatch(/1 of 2 drops claimed/);
});

test("unobtainable drops are left out of the progress bar", () => {
  // Counted, a campaign whose only unearned drop needs a sub would show
  // a bar that can never fill however long you watch.
  renderApp(<CampaignCard campaign={campaign({
    status: "partial",
    drops: [
      { id: "d1", name: "A", benefits: [], requiredMinutes: 60, minutes: 60,
        status: "claimed" },
      { id: "d2", name: "B", benefits: [], requiredMinutes: 60, minutes: 0,
        status: "unobtainable" },
    ],
  })} />);
  expect(screen.getByTestId("campaign-progress").getAttribute("aria-label"))
    .toMatch(/1 of 1 drops claimed/);
});

test("draws no progress bar when the inventory could not be read", () => {
  // A zeroed bar is a confident claim of no progress, which is exactly
  // what a failed fetch cannot support.
  renderApp(<CampaignCard campaign={campaign({ status: "unknown" })} />);
  expect(screen.queryByTestId("campaign-progress")).toBeNull();
});

test("shows how much of the campaign window has elapsed", () => {
  const now = Date.now();
  renderApp(<CampaignCard campaign={campaign({
    startsAt: now - 3_000,
    endsAt: now + 1_000,
  })} />);
  expect(
    screen.getByRole("progressbar", { name: /75% of the window elapsed/ }),
  ).toBeTruthy();
});

test("draws no elapsed bar for a campaign with no dates", () => {
  // A bar at zero would claim the window just opened.
  renderApp(<CampaignCard campaign={campaign({ startsAt: null, endsAt: null })} />);
  expect(screen.queryByTestId("campaign-elapsed")).toBeNull();
});

test("opens a gallery tile per drop", async () => {
  const user = userEvent.setup();
  renderApp(<CampaignCard campaign={campaign()} />);
  await user.click(screen.getByRole("button", { name: /Campaign One, 1 drop/ }));
  await waitFor(() => {
    expect(screen.getAllByTestId("drop-row")).toHaveLength(1);
  });
});

// --- scheduled campaigns ---

test("a campaign that has not opened yet counts down to its start", () => {
  // "25h left" on an unstarted campaign names its deadline, which reads
  // as time you could be earning it -- you cannot, it has not begun.
  const now = Date.now();
  renderApp(<CampaignCard campaign={campaign({
    startsAt: now + 2 * 60 * 60 * 1000,
    endsAt: now + 50 * 60 * 60 * 1000,
  })} />);
  expect(screen.getByTestId("campaign-ends").textContent).toMatch(/starts in 2h/i);
});

test("a scheduled campaign's badge says so rather than 'not started'", () => {
  // "not started" is about your progress and invites starting something
  // that cannot be started yet.
  const now = Date.now();
  renderApp(<CampaignCard campaign={campaign({
    startsAt: now + 60 * 60 * 1000,
    endsAt: now + 60 * 60 * 1000 * 20,
  })} />);
  expect(screen.getByTestId("campaign-status").textContent).toMatch(/scheduled/i);
});

test("a scheduled campaign's elapsed bar sits empty", () => {
  // None of its window has passed; a partly-filled bar would claim
  // otherwise.
  const now = Date.now();
  renderApp(<CampaignCard campaign={campaign({
    startsAt: now + 60 * 60 * 1000,
    endsAt: now + 5 * 60 * 60 * 1000,
  })} />);
  expect(
    screen.getByRole("progressbar", { name: /0% of the window elapsed/ }),
  ).toBeTruthy();
});

test("a running campaign still reports its deadline", () => {
  // The countdown only flips for a campaign that has not opened.
  const now = Date.now();
  renderApp(<CampaignCard campaign={campaign({
    startsAt: now - 60 * 60 * 1000,
    endsAt: now + 3 * 60 * 60 * 1000,
  })} />);
  expect(screen.getByTestId("campaign-ends").textContent).toMatch(/3h left/i);
});

test("a scheduled campaign with no end date still counts down to its start", () => {
  const now = Date.now();
  renderApp(<CampaignCard campaign={campaign({
    startsAt: now + 4 * 60 * 60 * 1000,
    endsAt: null,
  })} />);
  expect(screen.getByTestId("campaign-ends").textContent).toMatch(/starts in 4h/i);
});

// --- links out ---

test("the box art links to the game's Twitch category", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  expect(
    screen.getByRole("link", { name: /a game on twitch/i }).getAttribute("href"),
  ).toBe("https://twitch.tv/directory/category/a-game?filter=drops");
});

test("links out to the Twitch drops list", () => {
  // Deliberately not named for the campaign: Twitch's drops page is one
  // accordion with no per-campaign route, so the link opens the list and
  // cannot scroll to this campaign. Promising otherwise in the
  // accessible name would be a lie to a screen reader.
  renderApp(<CampaignCard campaign={campaign()} />);
  const link = screen.getByRole("link", { name: /^your twitch drops$/i });
  expect(link.getAttribute("href"))
    .toBe("https://www.twitch.tv/drops/campaigns");
});

test("the campaign link opens in a new tab", () => {
  renderApp(<CampaignCard campaign={campaign()} />);
  const link = screen.getByTestId("campaign-link");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toMatch(/noreferrer/);
});

test("the drops link does not depend on the campaign id", () => {
  // It never addressed the campaign, so a campaign without an id is no
  // reason to withhold it.
  renderApp(<CampaignCard campaign={campaign({ id: "" })} />);
  expect(screen.getByTestId("campaign-link").getAttribute("href"))
    .toBe("https://www.twitch.tv/drops/campaigns");
});

// --- the watch-time bar ---

const mins = (over: Partial<ResolvedDrop> & { requiredMinutes: number }) => ({
  id: `d${over.requiredMinutes}`,
  name: `Drop ${over.requiredMinutes}`,
  benefits: [],
  minutes: 0,
  status: "not-started" as const,
  ...over,
});

test("the bar spans the campaign's longest requirement, not their sum", () => {
  // Twitch counts one watch-time total against every drop's own
  // threshold, so a 15/30/60 campaign costs 60 minutes, not 105.
  expect(watchTime([
    mins({ requiredMinutes: 15 }),
    mins({ requiredMinutes: 30 }),
    mins({ requiredMinutes: 60 }),
  ])).toEqual({ required: 60, watched: 0, claimed: 0 });
});

test("watched minutes are the highest any drop reports", () => {
  // Each entry is clamped to its own requirement, so the earlier drops
  // understate the total once they are satisfied.
  expect(watchTime([
    mins({ requiredMinutes: 15, minutes: 15, status: "claimed" }),
    mins({ requiredMinutes: 30, minutes: 30, status: "claimed" }),
    mins({ requiredMinutes: 60, minutes: 47, status: "in-progress" }),
  ])).toMatchObject({ watched: 47 });
});

test("claimed minutes stop at the last drop actually claimed", () => {
  expect(watchTime([
    mins({ requiredMinutes: 15, minutes: 15, status: "claimed" }),
    mins({ requiredMinutes: 30, minutes: 30, status: "claimed" }),
    mins({ requiredMinutes: 60, minutes: 47, status: "in-progress" }),
  ])).toMatchObject({ claimed: 30 });
});

test("nothing claimed reports zero claimed minutes", () => {
  expect(watchTime([
    mins({ requiredMinutes: 15, minutes: 8, status: "in-progress" }),
    mins({ requiredMinutes: 30 }),
  ])).toMatchObject({ claimed: 0 });
});

test("a fully claimed campaign fills both segments", () => {
  expect(watchTime([
    mins({ requiredMinutes: 15, minutes: 15, status: "claimed" }),
    mins({ requiredMinutes: 60, minutes: 60, status: "claimed" }),
  ])).toEqual({ required: 60, watched: 60, claimed: 60 });
});

test("unobtainable drops are left out of the span", () => {
  // They can never be earned by watching, so a 240m gated drop must
  // not stretch the bar to a length no amount of watching reaches.
  expect(watchTime([
    mins({ requiredMinutes: 60, minutes: 60, status: "claimed" }),
    mins({ requiredMinutes: 240, status: "unobtainable" }),
  ])).toMatchObject({ required: 60 });
});

test("watched never exceeds the span even on inconsistent data", () => {
  // A drop reporting more minutes than the longest requirement would
  // otherwise overflow the track.
  expect(watchTime([
    mins({ requiredMinutes: 30, minutes: 30, status: "claimed" }),
    mins({ requiredMinutes: 60, minutes: 90, status: "in-progress" }),
  ])).toMatchObject({ required: 60, watched: 60 });
});

test("a campaign with no obtainable drops reports no bar", () => {
  expect(watchTime([mins({ requiredMinutes: 60, status: "unobtainable" })]))
    .toBeNull();
});

test("a campaign whose drops require no time reports no bar", () => {
  // Dividing by a zero span would render NaN across the track.
  expect(watchTime([mins({ requiredMinutes: 0 })])).toBeNull();
});

test("the bar shows claimed and watched as separate segments", () => {
  renderApp(<CampaignCard campaign={campaign({
    status: "partial",
    drops: [
      { id: "d1", name: "A", benefits: [], requiredMinutes: 30, minutes: 30,
        status: "claimed" },
      { id: "d2", name: "B", benefits: [], requiredMinutes: 120, minutes: 78,
        status: "in-progress" },
    ],
  })} />);
  // Claimed reaches 30 of 120 (25%); watching has reached 78 (65%), so
  // the second segment covers the 48 minutes between them (40%).
  const claimed = screen.getByTestId("seg-claimed");
  const watched = screen.getByTestId("seg-watched");
  expect(claimed.style.getPropertyValue("--progress-section-size")).toBe("25%");
  expect(watched.style.getPropertyValue("--progress-section-size")).toBe("40%");
});

test("the bar reports both figures to a screen reader", () => {
  renderApp(<CampaignCard campaign={campaign({
    status: "partial",
    drops: [
      { id: "d1", name: "A", benefits: [], requiredMinutes: 30, minutes: 30,
        status: "claimed" },
      { id: "d2", name: "B", benefits: [], requiredMinutes: 120, minutes: 78,
        status: "in-progress" },
    ],
  })} />);
  expect(screen.getByTestId("campaign-progress").getAttribute("aria-label"))
    .toMatch(/78 of 120 minutes watched.*1 of 2 drops claimed/i);
});

test("no watched segment when watching has not passed the claimed point", () => {
  // A campaign claimed up to date shows one solid segment, not a
  // zero-width sliver of a second colour.
  renderApp(<CampaignCard campaign={campaign({
    status: "partial",
    drops: [
      { id: "d1", name: "A", benefits: [], requiredMinutes: 30, minutes: 30,
        status: "claimed" },
      { id: "d2", name: "B", benefits: [], requiredMinutes: 120, minutes: 30,
        status: "in-progress" },
    ],
  })} />);
  expect(screen.queryByTestId("seg-watched")).toBeNull();
});

test("still draws nothing when the inventory could not be read", () => {
  renderApp(<CampaignCard campaign={campaign({ status: "unknown" })} />);
  expect(screen.queryByTestId("campaign-progress")).toBeNull();
});

// --- drop milestones on the bar ---

test("marks each drop's threshold along the bar", () => {
  // Positioned by minutes, so the ticks sit where the drops actually
  // fall: clustered early, then a long run to the finale.
  expect(milestones([
    mins({ requiredMinutes: 15 }),
    mins({ requiredMinutes: 30 }),
    mins({ requiredMinutes: 60 }),
  ], 60)).toEqual([25, 50]);
});

test("leaves out the final threshold, which is the bar's own end", () => {
  // A tick on the right edge is indistinguishable from the border and
  // marks nothing a reader cannot already see.
  expect(milestones([
    mins({ requiredMinutes: 30 }),
    mins({ requiredMinutes: 60 }),
  ], 60)).toEqual([50]);
});

test("two drops at the same threshold share one mark", () => {
  // Goblin Cleanup awards two rewards at 60 and two at 180; stacking
  // ticks at identical positions just draws a thicker line.
  expect(milestones([
    mins({ requiredMinutes: 60 }),
    mins({ requiredMinutes: 60 }),
    mins({ requiredMinutes: 180 }),
    mins({ requiredMinutes: 180 }),
    mins({ requiredMinutes: 360 }),
  ], 360)).toEqual([
    Math.round((60 / 360) * 10000) / 100,
    50,
  ]);
});

test("unobtainable drops get no mark", () => {
  // They can never be reached by watching, so a tick for one points at
  // a milestone that never arrives.
  expect(milestones([
    mins({ requiredMinutes: 30 }),
    mins({ requiredMinutes: 45, status: "unobtainable" }),
    mins({ requiredMinutes: 60 }),
  ], 60)).toEqual([50]);
});

test("a single-drop campaign gets no marks at all", () => {
  // Its only threshold is the end of the bar.
  expect(milestones([mins({ requiredMinutes: 60 })], 60)).toEqual([]);
});

test("drops beyond the span are not marked", () => {
  // Nothing should be plotted past the track's end.
  expect(milestones([
    mins({ requiredMinutes: 30 }),
    mins({ requiredMinutes: 60 }),
  ], 30)).toEqual([]);
});

test("draws a tick for each intermediate drop threshold", () => {
  renderApp(<CampaignCard campaign={campaign({
    status: "partial",
    drops: [
      { id: "d1", name: "A", benefits: [], requiredMinutes: 30, minutes: 30,
        status: "claimed" },
      { id: "d2", name: "B", benefits: [], requiredMinutes: 60, minutes: 40,
        status: "in-progress" },
      { id: "d3", name: "C", benefits: [], requiredMinutes: 120, minutes: 40,
        status: "in-progress" },
    ],
  })} />);
  const ticks = screen.getAllByTestId("drop-tick");
  // 30 and 60 of 120; the 120 itself is the bar's end.
  expect(ticks).toHaveLength(2);
  expect(ticks[0]?.style.left).toBe("25%");
  expect(ticks[1]?.style.left).toBe("50%");
});

test("a single-drop campaign draws no ticks", () => {
  renderApp(<CampaignCard campaign={campaign({
    status: "partial",
    drops: [
      { id: "d1", name: "A", benefits: [], requiredMinutes: 60, minutes: 20,
        status: "in-progress" },
    ],
  })} />);
  expect(screen.queryAllByTestId("drop-tick")).toHaveLength(0);
});

test("the ticks are decorative, the tooltip carrying the figures", () => {
  // A screen reader already gets minutes and drop counts from the bar's
  // label; announcing a dozen unlabelled marks would bury it.
  renderApp(<CampaignCard campaign={campaign({
    status: "partial",
    drops: [
      { id: "d1", name: "A", benefits: [], requiredMinutes: 30, minutes: 30,
        status: "claimed" },
      { id: "d2", name: "B", benefits: [], requiredMinutes: 60, minutes: 40,
        status: "in-progress" },
    ],
  })} />);
  for (const tick of screen.getAllByTestId("drop-tick")) {
    expect(tick.getAttribute("aria-hidden")).toBe("true");
  }
});

test("the countdown opens the exact dates on click", async () => {
  // "4d left" rounds to a single unit, so it spans most of a day either
  // way; someone deciding whether to start a campaign needs the real
  // deadline, and the card has no room to print it.
  const user = userEvent.setup();
  renderApp(<CampaignCard campaign={campaign({
    startsAt: Date.now() - 2 * 86_400_000,
    endsAt: Date.now() + 3 * 86_400_000,
  })} />);
  await user.click(screen.getByTestId("campaign-ends"));
  const panel = await screen.findByTestId("campaign-window");
  expect(panel.textContent).toMatch(/Starts/);
  expect(panel.textContent).toMatch(/Ends/);
  expect(screen.getByTestId("campaign-window-state").textContent)
    .toBe("started 2d ago");
});

test("the countdown is reachable without a pointer", async () => {
  // A tooltip opens on hover only, which no touch device can do -- the
  // reason this is a Popover behind a real button.
  renderApp(<CampaignCard campaign={campaign()} />);
  const target = screen.getByTestId("campaign-ends");
  expect(target.tagName).toBe("BUTTON");
  expect(target.getAttribute("aria-expanded")).toBe("false");
  await userEvent.setup().click(target);
  await waitFor(() =>
    expect(target.getAttribute("aria-expanded")).toBe("true"));
});

test("a campaign with no dates shows no window panel", () => {
  renderApp(<CampaignCard campaign={campaign({ startsAt: null, endsAt: null })} />);
  // The countdown itself is not rendered without a date to report.
  expect(screen.queryByTestId("campaign-ends")).toBeNull();
  expect(screen.queryByTestId("campaign-window")).toBeNull();
});

// --- following the campaign's game ---

test("offers to follow the campaign's game", async () => {
  const onFollowGame = vi.fn();
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={() => {}} onFollowGame={onFollowGame} />);
  await userEvent.click(screen.getByRole("button", { name: "Follow game" }));
  expect(onFollowGame).toHaveBeenCalled();
});

test("a followed game reads as followed and cannot be followed again", async () => {
  const onFollowGame = vi.fn();
  renderApp(<CampaignCard campaign={campaign()} onSubscribe={() => {}} onFollowGame={onFollowGame} gameFollowed />);
  const button = screen.getByRole("button", { name: "Following game" });
  expect(button).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(button);
  expect(onFollowGame).not.toHaveBeenCalled();
});

test("a campaign with no game offers no follow", () => {
  renderApp(<CampaignCard campaign={campaign({ game: null })} onSubscribe={() => {}} onFollowGame={() => {}} />);
  expect(screen.queryByRole("button", { name: /follow/i })).toBeNull();
});
