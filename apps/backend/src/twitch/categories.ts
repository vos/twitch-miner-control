/**
 * Twitch's category catalogue: search, and lookup by id.
 *
 * Plain GQL queries against the public endpoint with the web client id.
 * They need no session and no persisted-query hash, so they keep working
 * while the account is signed out and cannot be broken by Twitch
 * rotating hashes. Runs here rather than in the Python helper, which
 * serves one request at a time: typing into the search would otherwise
 * wait behind a directory lookup that takes seconds.
 */

const GQL_URL = "https://gql.twitch.tv/gql";
const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const TIMEOUT_MS = 5_000;
const MAX_RESULTS = 10;
const FIELDS = "id displayName slug boxArtURL(width: 144, height: 192)";

export interface TwitchGame {
  /** Twitch game id; the same id the campaign catalogue carries. */
  id: string;
  name: string;
  slug: string;
  boxArtUrl: string | null;
}

interface GameNode {
  id?: unknown;
  displayName?: unknown;
  slug?: unknown;
  boxArtURL?: unknown;
}

function toGame(node: GameNode | null | undefined): TwitchGame | null {
  if (node == null || typeof node.id !== "string"
      || typeof node.displayName !== "string" || node.displayName === "") {
    return null;
  }
  return {
    id: node.id,
    name: node.displayName,
    slug: typeof node.slug === "string" ? node.slug : "",
    boxArtUrl: typeof node.boxArtURL === "string" && node.boxArtURL !== ""
      ? node.boxArtURL
      : null,
  };
}

export function twitchGames(fetchImpl: typeof fetch = fetch) {
  /** Throws on any failure: an empty answer must only ever mean "no match". */
  async function query<T>(text: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(GQL_URL, {
      method: "POST",
      headers: { "Client-Id": CLIENT_ID, "Content-Type": "application/json" },
      body: JSON.stringify({ query: text, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Twitch returned HTTP ${res.status}`);
    const payload = await res.json() as { data?: T | null; errors?: Array<{ message?: string }> };
    if (payload.errors !== undefined && payload.errors.length > 0) {
      throw new Error(`Twitch: ${payload.errors[0]?.message ?? "query failed"}`);
    }
    if (payload.data === undefined || payload.data === null) {
      throw new Error("Twitch returned no data");
    }
    return payload.data;
  }

  async function search(text: string, first = MAX_RESULTS): Promise<TwitchGame[]> {
    const data = await query<{
      searchCategories: { edges?: Array<{ node?: GameNode }> } | null;
    }>(
      `query($q: String!, $first: Int!) { searchCategories(query: $q, first: $first) { edges { node { ${FIELDS} } } } }`,
      { q: text, first },
    );
    return (data.searchCategories?.edges ?? [])
      .map((e) => toGame(e.node))
      .filter((g): g is TwitchGame => g !== null);
  }

  async function byId(id: string): Promise<TwitchGame | null> {
    const data = await query<{ game: GameNode | null }>(
      `query($id: ID!) { game(id: $id) { ${FIELDS} } }`,
      { id },
    );
    return toGame(data.game);
  }

  /**
   * What the Follow dialog shows for a query.
   *
   * An all-digit query is also tried as a game id, first, so a pasted
   * Twitch id finds its game even when the name search would not.
   */
  async function find(raw: string): Promise<TwitchGame[]> {
    const text = raw.trim();
    if (text.length < 2) return [];
    const [exact, found] = await Promise.all([
      /^\d+$/.test(text) ? byId(text) : Promise.resolve(null),
      search(text, MAX_RESULTS),
    ]);
    const rest = found.filter((g) => g.id !== exact?.id);
    return (exact === null ? rest : [exact, ...rest]).slice(0, MAX_RESULTS);
  }

  return { search, byId, find };
}

export type TwitchGames = ReturnType<typeof twitchGames>;
