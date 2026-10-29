import type {
  Campaign, CampaignBenefit, CampaignDrop,
} from "./campaignCatalogue.js";

/**
 * Where the campaign list comes from, and why it is not Twitch.
 *
 * Twitch's own ViewerDropsDashboard query -- the one behind
 * twitch.tv/drops/campaigns -- is gated behind Kasada bot detection. It
 * answers HTTP 200 with the campaigns field nulled and a partial error:
 *
 *   {"message":"failed integrity check",
 *    "path":["currentUser","dropCampaigns"],
 *    "extensions":{"code":"IntegrityCheckFailed"}}
 *
 * An integrity token from gql.twitch.tv/integrity does not satisfy it:
 * the endpoint is fronted by Kasada (X-Kpsdk-* response headers), whose
 * challenge needs a browser to execute. Upstream hit the same wall --
 * their post_integrity is commented out in Twitch.py. Beating it means
 * driving a headless browser at an anti-bot system, which is fragile
 * and a good way to get the account banned.
 *
 * So the catalogue comes from a public tracker instead, and progress
 * still comes from Twitch: the Inventory query is NOT gated and works
 * with the session the miner already holds. That split is deliberate --
 * see docs/superpowers/specs/2026-09-17-drop-campaigns-design.md.
 */
const SOURCE_ORIGIN = "https://twitch-drops.fenrisapps.com";

/** Long enough for a cold render, short enough not to hang a refresh. */
const TIMEOUT_MS = 20_000;

/**
 * Game pages fetched at once.
 *
 * A sweep is ~90 pages, all prerendered and served from the tracker's
 * edge cache, but with a long tail -- a few take 2-4s. Someone is
 * watching a spinner for the whole sweep: four at a time measured
 * 23-25s, eight 11-15s. Eight is still a light load on a cached site
 * read once a day.
 */
const CONCURRENCY = 8;

/**
 * The source is a React Server Component stream, not an API. Asking for
 * it with this header returns the data payload; without it the server
 * renders HTML with the campaigns baked into markup instead.
 *
 * This is an undocumented internal format with no stability promise. It
 * will break when they redeploy their frontend -- which is why every
 * failure here throws rather than returning an empty list, so the
 * catalogue can report itself unavailable instead of claiming that no
 * campaigns are running.
 */
const RSC_HEADERS = { RSC: "1", "User-Agent": "twitch-miner-control" };

interface SourceBenefit {
  name?: string;
  /** The reward's own artwork, shown on the drop tile. */
  imageAssetUrl?: string;
}

/**
 * A drop as a game page lists it.
 *
 * No window of its own: the game pages carry only the campaign's, so a
 * drop narrower than its campaign is shown with the campaign's dates.
 * Rare in practice -- the last source that did carry drop windows had
 * every one of 95 drops matching its campaign exactly.
 */
interface SourceDrop {
  id?: string;
  name?: string;
  requiredMinutesWatched?: number;
  requiresSub?: boolean;
  benefits?: SourceBenefit[];
}

interface SourceCampaign {
  id?: string;
  name?: string;
  startAt?: string;
  endAt?: string;
  drops?: SourceDrop[];
}

/**
 * A game from the /games index.
 *
 * Its campaigns are summaries -- rewards flattened across drops, no drop
 * ids -- so they say only which games are worth fetching. Progress is
 * joined to drops by id, which only the game page has.
 */
interface SourceGame {
  id?: string;
  /** The tracker's own slug, for its URLs. Not always Twitch's. */
  urlSlug?: string;
  displayName?: string;
  boxArtUrl?: string;
  /** The studio behind the game's campaigns, shown on the card. */
  publisher?: string;
  campaigns?: { id?: string }[];
}

/** What a game page contributes beyond the index. */
export interface GamePage {
  /**
   * Twitch's category slug, which the directory query needs.
   *
   * Differs from the tracker's urlSlug when Twitch's is taken -- FELLOWSHIP
   * is "fellowship" on the tracker and "fellowship-1" on Twitch -- so the
   * urlSlug is only a fallback for a page that omits this.
   */
  twitchSlug: string | null;
  campaigns: SourceCampaign[];
}

/**
 * Finds the end of the JSON value starting at `open`.
 *
 * String-aware, because campaign names contain brackets ("Drops [Week
 * 2]") and a naive bracket count truncates the array at the first one.
 */
function endOfValue(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("array is not terminated");
}

/**
 * Every array embedded under `key` in an RSC stream, parsed.
 *
 * All of them rather than the first, because a page repeats a key with
 * different shapes -- a game page has a dozen "campaigns" arrays, most
 * holding only a window for a badge -- and the caller picks by shape.
 */
function arraysAt(body: string, key: string): unknown[][] {
  const needle = `"${key}":[`;
  const out: unknown[][] = [];
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + 1)) {
    const open = at + needle.length - 1;
    const raw = body.slice(open, endOfValue(body, open) + 1);
    // RSC prefixes dates with "$D", which no JSON date parser accepts.
    const cleaned = raw.replace(
      /"\$D(\d{4}-\d{2}-\d{2}T[^"]*)"/g,
      (_whole, iso: string) => `"${iso}"`,
    );
    out.push(JSON.parse(cleaned) as unknown[]);
  }
  return out;
}

/** Epoch ms from an RSC date, or null when absent or unparseable. */
function epochMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value !== "";

/**
 * A drop's awards, deduped, each keeping its own artwork.
 *
 * Deduped on name *and* image rather than name alone: a drop granting
 * two of an item repeats the name, but two genuinely different rewards
 * sharing a name are distinct tiles and collapsing them would drop one
 * from the gallery. A benefit with no name is skipped entirely -- an
 * unnamed tile is not something the card can label.
 */
function toBenefits(benefits: SourceBenefit[] | undefined): CampaignBenefit[] {
  const seen = new Set<string>();
  const out: CampaignBenefit[] = [];
  for (const b of benefits ?? []) {
    if (!nonEmpty(b.name)) continue;
    const imageUrl = nonEmpty(b.imageAssetUrl) ? b.imageAssetUrl : null;
    const key = `${b.name}\u0000${imageUrl ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: b.name, imageUrl });
  }
  return out;
}

function toDrop(drop: SourceDrop): CampaignDrop {
  return {
    id: drop.id ?? "",
    name: drop.name ?? "Drop",
    benefits: toBenefits(drop.benefits),
    requiredMinutes: drop.requiredMinutesWatched ?? 0,
    // A boolean upstream, a count here: the rest of the app reads
    // requiredSubs > 0 as unobtainable, matching Twitch's own field.
    requiredSubs: drop.requiresSub === true ? 1 : 0,
    startsAt: null,
    endsAt: null,
  };
}

/**
 * Parses the game list out of the /games index.
 *
 * Exported separately from the fetch so the parsing -- the part that
 * breaks when the source changes -- is testable against a fixture with
 * no network. Throws on anything unexpected; see fetchCampaigns.
 */
export function extractGames(body: string): SourceGame[] {
  const [games] = arraysAt(body, "games");
  if (games === undefined) {
    throw new Error("no games array in the index; the source format changed");
  }
  return games as SourceGame[];
}

/**
 * Tracker slugs of the games the home page features, scheduled ones
 * included.
 *
 * The index lists a game's campaigns only once one is running, so a game
 * whose next campaign has not opened yet shows there with none. The home
 * page's "Scheduled campaigns" section is the only place those appear.
 * Read from the arrays carrying timeBasedDrops -- the home page alone
 * still uses Twitch's own shape.
 */
export function extractFeaturedSlugs(body: string): string[] {
  const lists = arraysAt(body, "campaigns").filter((list) =>
    list.some((c) => typeof c === "object" && c !== null && "timeBasedDrops" in c),
  );
  if (lists.length === 0) {
    throw new Error("no campaigns on the home page; the source format changed");
  }
  const slugs = lists.flat().map((c) =>
    (c as { game?: { urlSlug?: string } | null }).game?.urlSlug);
  return [...new Set(slugs.filter(nonEmpty))];
}

/**
 * Parses a game page for its full campaigns and its Twitch slug.
 *
 * The full campaigns are the one "campaigns" array whose entries carry
 * drops; the others on the page are window-only stubs for badges, and
 * "history" holds past campaigns in the index's summary shape.
 */
export function extractGamePage(body: string): GamePage {
  const campaigns = arraysAt(body, "campaigns").find((list) =>
    list.some((c) => typeof c === "object" && c !== null && "drops" in c),
  );
  if (campaigns === undefined) {
    throw new Error("no campaigns with drops on a game page; the source format changed");
  }
  const slug = /"twitchSlug":"([^"]+)"/.exec(body)?.[1];
  return { twitchSlug: slug ?? null, campaigns: campaigns as SourceCampaign[] };
}

/**
 * One game page's campaigns, in the catalogue's shape.
 *
 * Campaigns that have ended are dropped. The page is served from an edge
 * cache and keeps a campaign for a while after it closes, and an ended
 * campaign in the catalogue would be offered for subscribing. Upcoming
 * ones are kept -- the page lists them days further ahead than the
 * index does, which is notice the subscription queue can use.
 */
export function toCampaigns(game: SourceGame, page: GamePage, now: number): Campaign[] {
  const gameRef = game.id === undefined
    ? null
    : {
        id: game.id,
        slug: page.twitchSlug ?? game.urlSlug ?? "",
        displayName: game.displayName ?? "",
        boxArtUrl: nonEmpty(game.boxArtUrl) ? game.boxArtUrl : null,
      };
  // The game's publisher, not the campaign's own owner -- the game pages
  // no longer name one. The same studio in all but the odd co-promotion.
  const owner = nonEmpty(game.publisher) ? { name: game.publisher, type: "" } : null;
  return page.campaigns
    .filter((c) => {
      const endsAt = epochMs(c.endAt);
      return endsAt === null || endsAt > now;
    })
    .map((c) => ({
      id: c.id ?? "",
      name: c.name ?? "Campaign",
      game: gameRef,
      owner,
      startsAt: epochMs(c.startAt),
      endsAt: epochMs(c.endAt),
      drops: (c.drops ?? []).map(toDrop),
    }));
}

export interface FetchCampaignsOptions {
  fetchImpl?: typeof fetch;
  origin?: string;
  now?: () => number;
}

async function fetchRsc(fetchImpl: typeof fetch, url: string): Promise<string> {
  const res = await fetchImpl(url, {
    headers: RSC_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`campaign source returned HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

/**
 * Every tracked campaign. Throws on any failure -- never returns [].
 *
 * The index names the games with current campaigns and the home page
 * adds those with only scheduled ones; each game's page then supplies
 * the drop detail. All or nothing: a sweep missing one
 * game's campaigns would read downstream as those campaigns ending, so a
 * single failed page fails the whole fetch and the catalogue keeps
 * serving its previous list.
 */
export async function fetchCampaigns(
  { fetchImpl = fetch, origin = SOURCE_ORIGIN, now = Date.now }: FetchCampaignsOptions = {},
): Promise<Campaign[]> {
  const [index, home] = await Promise.all([
    fetchRsc(fetchImpl, `${origin}/games`),
    fetchRsc(fetchImpl, `${origin}/`),
  ]);
  const featured = new Set(extractFeaturedSlugs(home));
  const games = extractGames(index).filter((g) =>
    nonEmpty(g.urlSlug)
    && ((g.campaigns?.length ?? 0) > 0 || featured.has(g.urlSlug)));

  const perGame: Campaign[][] = new Array(games.length);
  let next = 0;
  const worker = async () => {
    while (next < games.length) {
      const i = next;
      next += 1;
      const game = games[i]!;
      const url = `${origin}/games/${encodeURIComponent(game.urlSlug!)}`;
      const read = async () => extractGamePage(await fetchRsc(fetchImpl, url));
      // One retry: across ~90 pages the odd one comes back without its
      // data, once in a few sweeps, and one bad page fails the sweep.
      const page = await read().catch(read);
      perGame[i] = toCampaigns(game, page, now());
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, games.length) }, worker),
  );

  // A campaign can sit under two games on the tracker; keep the first.
  const seen = new Set<string>();
  const campaigns = perGame.flat().filter((c) => !seen.has(c.id) && seen.add(c.id));
  // Twitch is never without a drop campaign, so none at all is a parse
  // that matched the wrong thing -- the last redesign made an empty
  // array parse as the whole list, and every subscription ended as its
  // campaign went "gone". Thrown so the previous list keeps serving.
  if (campaigns.length === 0) {
    throw new Error("the source listed no campaigns at all; its format probably changed");
  }
  return campaigns;
}
