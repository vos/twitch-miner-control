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
const SOURCE_URL = "https://twitch-drops.fenrisapps.com/campaigns";

/** Long enough for a cold render, short enough not to hang a refresh. */
const TIMEOUT_MS = 20_000;

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

/** The array key holding the campaign list inside the RSC stream. */
const KEY = '"campaigns":[';

interface SourceBenefit {
  name?: string;
  /** The reward's own artwork, shown on the drop tile. */
  imageAssetUrl?: string;
}

interface SourceDrop {
  id?: string;
  name?: string;
  requiredMinutesWatched?: number;
  requiresSub?: boolean;
  /** A drop's window can be narrower than its campaign's. */
  startAt?: string;
  endAt?: string;
  benefits?: SourceBenefit[];
}

interface SourceCampaign {
  id?: string;
  name?: string;
  startAt?: string;
  endAt?: string;
  game?: {
    id?: string;
    displayName?: string;
    slug?: string;
    boxArtUrl?: string;
  } | null;
  owner?: { name?: string; type?: string } | null;
  timeBasedDrops?: SourceDrop[];
}

/**
 * Finds the end of the JSON array starting at `open`.
 *
 * String-aware, because campaign names contain brackets ("Drops [Week
 * 2]") and a naive bracket count truncates the array at the first one.
 */
function endOfArray(text: string, open: number): number {
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
  throw new Error("campaigns array is not terminated");
}

/** Epoch ms from an RSC date, or null when absent or unparseable. */
function epochMs(value: string | undefined): number | null {
  if (value === undefined) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

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
    if (typeof b.name !== "string" || b.name === "") continue;
    const imageUrl =
      typeof b.imageAssetUrl === "string" && b.imageAssetUrl !== ""
        ? b.imageAssetUrl
        : null;
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
    startsAt: epochMs(drop.startAt),
    endsAt: epochMs(drop.endAt),
  };
}

/**
 * Parses the campaign list out of an RSC stream.
 *
 * Exported separately from the fetch so the parsing -- the part that
 * breaks when the source changes -- is testable against a fixture with
 * no network.
 *
 * Throws rather than returning [] on anything unexpected. An empty list
 * is a claim that no campaigns are running, and this function is never
 * in a position to make it.
 */
export function extractCampaigns(body: string): Campaign[] {
  const at = body.indexOf(KEY);
  if (at === -1) {
    throw new Error("no campaigns array in the response; the source format changed");
  }
  const open = at + KEY.length - 1;
  const raw = body.slice(open, endOfArray(body, open) + 1);
  // RSC prefixes dates with "$D", which no JSON date parser accepts.
  const cleaned = raw.replace(
    /"\$D(\d{4}-\d{2}-\d{2}T[^"]*)"/g,
    (_whole, iso: string) => `"${iso}"`,
  );
  const parsed = JSON.parse(cleaned) as SourceCampaign[];
  return parsed.map((c) => ({
    id: c.id ?? "",
    name: c.name ?? "Campaign",
    game:
      c.game && c.game.id !== undefined
        ? {
            id: c.game.id,
            slug: c.game.slug ?? "",
            displayName: c.game.displayName ?? "",
            boxArtUrl:
              typeof c.game.boxArtUrl === "string" && c.game.boxArtUrl !== ""
                ? c.game.boxArtUrl
                : null,
          }
        : null,
    owner:
      c.owner && typeof c.owner.name === "string" && c.owner.name !== ""
        ? { name: c.owner.name, type: c.owner.type ?? "" }
        : null,
    startsAt: epochMs(c.startAt),
    endsAt: epochMs(c.endAt),
    drops: (c.timeBasedDrops ?? []).map(toDrop),
  }));
}

export interface FetchCampaignsOptions {
  fetchImpl?: typeof fetch;
  url?: string;
}

/** Every tracked campaign. Throws on any failure -- never returns []. */
export async function fetchCampaigns(
  { fetchImpl = fetch, url = SOURCE_URL }: FetchCampaignsOptions = {},
): Promise<Campaign[]> {
  const res = await fetchImpl(url, {
    headers: RSC_HEADERS,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`campaign source returned HTTP ${res.status}`);
  }
  return extractCampaigns(await res.text());
}
