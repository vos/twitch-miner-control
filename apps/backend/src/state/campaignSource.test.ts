import { expect, test, vi } from "vitest";
import {
  extractFeaturedSlugs, extractGamePage, extractGames, fetchCampaigns,
  toCampaigns, type GamePage,
} from "./campaignSource.js";

/**
 * Miniatures of the real payloads. Each embeds its data in a React
 * Server Component stream, surrounded by rendered markup, with dates
 * carrying the `$D` marker the RSC format prefixes them with.
 */
const rsc = (line: string) =>
  `3:["$","div",null,{"className":"x","children":"Twitch Drops"}]
4:${line}
5:["$","footer",null,{}]`;

const NOW = Date.parse("2026-10-29T12:00:00.000Z");

/** The /games index: every game, campaigns summarised without drop ids. */
const index = rsc(`["$","$L26",null,{"games":[
  {"id":"500188","urlSlug":"hunt-showdown","displayName":"Hunt: Showdown 1896",
   "boxArtUrl":"https://cdn/ttv-boxart/500188.jpg","publisher":"Crytek",
   "lastEndedAt":"$D2026-10-16T16:59:59.999Z",
   "campaigns":[{"id":"c1","name":"Halloween","startAt":"$D2026-10-26T15:00:00.000Z",
     "endAt":"$D2026-11-09T13:59:59.999Z",
     "rewards":[{"name":"Hunt Red","imageUrl":"x","minutes":0,"sub":true}]}]},
  {"id":"177579460","urlSlug":"fellowship","displayName":"FELLOWSHIP",
   "publisher":"Chief Rebel","campaigns":[]},
  {"id":"1","urlSlug":"quiet-game","displayName":"Quiet","campaigns":[]}
]}]`);

/** The home page: featured campaigns, the only place in Twitch's shape. */
const home = rsc(`["$","$L2b",null,{"campaigns":[
  {"id":"c9","name":"Scheduled","startAt":"$D2026-10-30T15:00:00.000Z",
   "endAt":"$D2026-11-01T14:59:59.999Z",
   "game":{"id":"177579460","slug":"fellowship-1","urlSlug":"fellowship"},
   "timeBasedDrops":[]}
]}]`);

/**
 * A game page. The full campaigns sit beside window-only stubs (for the
 * "live now" badge) and a summary-shaped history, all under similar keys.
 */
const gamePage = (campaigns: string, slug = `"twitchSlug":"hunt-showdown",`) =>
  `1:["$","$L2b",null,{"campaigns":[{"startAt":"$D2026-10-26T15:00:00.000Z","endAt":"$D2026-11-09T13:59:59.999Z"}]}]
2:["$","$L44",null,{"gameName":"Hunt",${slug}"windows":"$26:props"}]
3:["$","$L3e",null,{"campaigns":${campaigns}}]
4:["$","$L43",null,{"history":[{"id":"old","name":"Week 2","dropCount":1,
  "rewards":[{"name":"Crate","imageUrl":"x","minutes":30,"sub":false}]}]}]`;

const huntCampaigns = `[
  {"id":"c1","name":"HS 1896 Halloween 2026",
   "startAt":"$D2026-10-26T14:54:34.000Z","endAt":"$D2026-11-09T13:59:59.999Z",
   "drops":[
     {"id":"d1","name":"Hunt Red","requiredMinutesWatched":0,"requiresSub":true,
      "benefits":[{"benefitId":"b1","name":"Hunt Red","imageAssetUrl":"https://cdn/REWARD/b1.png"}]},
     {"id":"d2","name":"Starter Pack","requiredMinutesWatched":60,"requiresSub":false,
      "benefits":[
        {"benefitId":"b2","name":"Binocular","imageAssetUrl":"https://cdn/REWARD/b2.png"},
        {"benefitId":"b3","name":"G3"},
        {"benefitId":"b2","name":"Binocular","imageAssetUrl":"https://cdn/REWARD/b2.png"}]}]},
  {"id":"c2","name":"Week 1 [Pt. 2]",
   "startAt":"$D2026-10-30T15:00:00.000Z","endAt":"$D2026-11-02T14:59:59.999Z",
   "drops":[]},
  {"id":"c3","name":"Ended Last Week",
   "startAt":"$D2026-10-14T15:00:00.000Z","endAt":"$D2026-10-27T14:59:59.999Z",
   "drops":[]}
]`;

const huntGame = extractGames(index)[0]!;
const huntPage = (): GamePage => extractGamePage(gamePage(huntCampaigns));

test("reads every game off the index", () => {
  const games = extractGames(index);
  expect(games.map((g) => g.urlSlug)).toEqual(["hunt-showdown", "fellowship", "quiet-game"]);
});

test("throws when the index carries no games array", () => {
  // The source's format changed, or we were served something else
  // entirely. Throwing lets the catalogue mark itself unavailable rather
  // than reporting an empty list as fact.
  expect(() => extractGames("<html>nothing here</html>")).toThrow(/games/i);
});

test("reads the featured games' slugs off the home page", () => {
  expect(extractFeaturedSlugs(home)).toEqual(["fellowship"]);
});

test("throws when the home page carries no campaigns", () => {
  expect(() => extractFeaturedSlugs(rsc(`{"campaigns":[{"startAt":"x"}]}`)))
    .toThrow(/home page/);
});

test("picks the campaigns with drops out of a game page", () => {
  // Not the window-only stubs before them, and not the history after.
  expect(huntPage().campaigns.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
});

test("reads Twitch's slug off a game page", () => {
  expect(huntPage().twitchSlug).toBe("hunt-showdown");
});

test("throws when a game page has no campaigns with drops", () => {
  expect(() => extractGamePage(gamePage(`[{"startAt":"x"}]`))).toThrow(/game page/);
});

test("throws on a campaigns array that is not valid JSON", () => {
  expect(() => extractGamePage(`x:{"campaigns":[{"id":`)).toThrow();
});

test("strips the RSC date marker and converts to epoch ms", () => {
  // "$D2026-10-26T…" is not a date any parser accepts as-is.
  const [out] = toCampaigns(huntGame, huntPage(), NOW);
  expect(out?.startsAt).toBe(Date.parse("2026-10-26T14:54:34.000Z"));
  expect(out?.endsAt).toBe(Date.parse("2026-11-09T13:59:59.999Z"));
});

test("maps drops onto the shape the rest of the app already uses", () => {
  const [out] = toCampaigns(huntGame, huntPage(), NOW);
  expect(out?.drops[1]).toEqual({
    id: "d2",
    name: "Starter Pack",
    benefits: [
      { name: "Binocular", imageUrl: "https://cdn/REWARD/b2.png" },
      { name: "G3", imageUrl: null },
    ],
    requiredMinutes: 60,
    requiredSubs: 0,
    startsAt: null,
    endsAt: null,
  });
});

test("carries requiresSub through as the sub requirement", () => {
  // The rest of the app reads requiredSubs > 0 as unobtainable, so the
  // boolean has to become a count rather than being dropped.
  const [out] = toCampaigns(huntGame, huntPage(), NOW);
  expect(out?.drops[0]?.requiredSubs).toBe(1);
});

test("takes the game from the index and its slug from the game page", () => {
  const [out] = toCampaigns(huntGame, huntPage(), NOW);
  expect(out?.game).toEqual({
    id: "500188",
    slug: "hunt-showdown",
    displayName: "Hunt: Showdown 1896",
    boxArtUrl: "https://cdn/ttv-boxart/500188.jpg",
  });
});

test("prefers Twitch's slug when the tracker's differs", () => {
  // The directory query takes Twitch's slug; the tracker's own one for
  // FELLOWSHIP finds nothing there.
  const fellowship = extractGames(index)[1]!;
  const page = extractGamePage(
    gamePage(huntCampaigns, `"twitchSlug":"fellowship-1",`),
  );
  expect(toCampaigns(fellowship, page, NOW)[0]?.game?.slug).toBe("fellowship-1");
});

test("falls back to the tracker's slug when the page omits Twitch's", () => {
  const page = extractGamePage(gamePage(huntCampaigns, ""));
  expect(toCampaigns(huntGame, page, NOW)[0]?.game?.slug).toBe("hunt-showdown");
});

test("names the game's publisher as the campaign owner", () => {
  const [out] = toCampaigns(huntGame, huntPage(), NOW);
  expect(out?.owner).toEqual({ name: "Crytek", type: "" });
});

test("survives a game with no box art or publisher", () => {
  // The card falls back rather than rendering a broken image or a blank.
  const [out] = toCampaigns(extractGames(index)[2]!, huntPage(), NOW);
  expect(out?.game?.boxArtUrl).toBeNull();
  expect(out?.owner).toBeNull();
});

test("drops campaigns that have ended and keeps upcoming ones", () => {
  // The cached page lingers on a closed campaign, and lists the next
  // ones further ahead than the index does.
  const out = toCampaigns(huntGame, huntPage(), NOW);
  expect(out.map((c) => c.name)).toEqual(["HS 1896 Halloween 2026", "Week 1 [Pt. 2]"]);
});

/** A fetch answering each URL from a table, 404 for anything else. */
function site(pages: Record<string, string | (() => string)>) {
  return vi.fn(async (url: string) => {
    const page = pages[url.replace("https://twitch-drops.fenrisapps.com", "")];
    if (page === undefined) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => (typeof page === "string" ? page : page()) };
  });
}

const fellowshipPage = gamePage(`[
  {"id":"c9","name":"Scheduled","startAt":"$D2026-10-30T15:00:00.000Z",
   "endAt":"$D2026-11-01T14:59:59.999Z","drops":[]},
  {"id":"c1","name":"Shared","startAt":"$D2026-10-26T15:00:00.000Z",
   "endAt":"$D2026-11-09T13:59:59.999Z","drops":[]}]`, `"twitchSlug":"fellowship-1",`);

const fetchAll = (impl: ReturnType<typeof site>) =>
  fetchCampaigns({ fetchImpl: impl as unknown as typeof fetch, now: () => NOW });

test("sweeps the game pages of running and featured games only", async () => {
  // fellowship has nothing running, so only the home page reveals its
  // scheduled campaign; quiet-game has nothing at all and is not fetched.
  const impl = site({
    "/games": index, "/": home,
    "/games/hunt-showdown": gamePage(huntCampaigns),
    "/games/fellowship": fellowshipPage,
  });
  const out = await fetchAll(impl);
  // c1 sits under both games; the first one keeps it.
  expect(out.map((c) => c.id)).toEqual(["c1", "c2", "c9"]);
  expect(impl.mock.calls.map(([url]) => url)).not.toContain(
    "https://twitch-drops.fenrisapps.com/games/quiet-game",
  );
});

test("fetches with the RSC header the source needs", async () => {
  // Without it the server returns rendered HTML with no data in it.
  const impl = site({
    "/games": index, "/": home,
    "/games/hunt-showdown": gamePage(huntCampaigns),
    "/games/fellowship": fellowshipPage,
  });
  await fetchAll(impl);
  for (const call of impl.mock.calls) {
    const init = (call as unknown[])[1] as RequestInit;
    expect((init.headers as Record<string, string>)["RSC"]).toBe("1");
  }
});

test("retries a game page that comes back without its data", async () => {
  let served = 0;
  const impl = site({
    "/games": index, "/": home,
    "/games/hunt-showdown": () => (served++ === 0 ? "<html></html>" : gamePage(huntCampaigns)),
    "/games/fellowship": fellowshipPage,
  });
  expect(await fetchAll(impl)).toHaveLength(3);
});

test("fails the whole sweep when a game page stays broken", async () => {
  // A catalogue missing one game's campaigns would read downstream as
  // those campaigns ending.
  const impl = site({ "/games": index, "/": home, "/games/fellowship": fellowshipPage });
  await expect(fetchAll(impl)).rejects.toThrow(/404/);
});

test("throws rather than reporting that no campaigns are running", async () => {
  // An empty list ends every subscription downstream as "gone", and it
  // is what a parse matching the wrong array looks like.
  const impl = site({
    "/games": rsc(`{"games":[{"id":"1","urlSlug":"quiet-game","campaigns":[]}]}`),
    "/": home.replace('"urlSlug":"fellowship"', '"urlSlug":"elsewhere"'),
  });
  await expect(fetchAll(impl)).rejects.toThrow(/no campaigns/);
});

test("throws on a non-ok index rather than returning nothing", async () => {
  const impl = site({ "/": home });
  await expect(fetchAll(impl)).rejects.toThrow(/404/);
});
