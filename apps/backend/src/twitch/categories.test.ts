import { expect, test, vi } from "vitest";
import { twitchGames } from "./categories.js";

const node = (id: string, name: string) => ({
  id, displayName: name, slug: name.toLowerCase().replace(/\s+/g, "-"),
  boxArtURL: `https://static-cdn.jtvnw.net/ttv-boxart/${id}_IGDB-144x192.jpg`,
});

/** A fetch that answers each GQL body with `reply(body)`. */
function stub(
  reply: (body: { query: string; variables: Record<string, unknown> }) => unknown,
  init: { status?: number } = {},
) {
  return vi.fn(async (_url: string | URL | Request, req?: RequestInit) => ({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => reply(JSON.parse(String(req?.body))),
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

test("search parses Twitch's category nodes", async () => {
  const fetchImpl = stub(() => ({ data: { searchCategories: { edges: [
    { node: node("512953", "ELDEN RING") },
  ] } } }));
  expect(await twitchGames(fetchImpl).search("elden")).toEqual([{
    id: "512953", name: "ELDEN RING", slug: "elden-ring",
    boxArtUrl: "https://static-cdn.jtvnw.net/ttv-boxart/512953_IGDB-144x192.jpg",
  }]);
});

test("the search text travels as a variable, never inside the query", async () => {
  // A quote or brace in a game name must not break the query.
  const fetchImpl = stub(() => ({ data: { searchCategories: { edges: [] } } }));
  const text = "Tom Clancy's \"Rainbow\" }{";
  await twitchGames(fetchImpl).search(text);
  const [, req] = fetchImpl.mock.calls[0] as [string, RequestInit];
  const body = JSON.parse(String(req.body));
  expect(body.variables.q).toBe(text);
  expect(body.query).not.toContain("Rainbow");
  expect((req.headers as Record<string, string>)["Client-Id"])
    .toBe("kimne78kx3ncx6brgo4mv6wki5h1ko");
});

test("byId returns null for an id Twitch does not know", async () => {
  const fetchImpl = stub(() => ({ data: { game: null } }));
  expect(await twitchGames(fetchImpl).byId("999999999999")).toBeNull();
});

test("a GQL error throws rather than reading as no results", async () => {
  const fetchImpl = stub(() => ({ errors: [{ message: "service timeout" }] }));
  await expect(twitchGames(fetchImpl).search("rust")).rejects.toThrow(/service timeout/);
});

test("a non-200 answer throws", async () => {
  const fetchImpl = stub(() => ({}), { status: 503 });
  await expect(twitchGames(fetchImpl).byId("1")).rejects.toThrow(/503/);
});

test("find skips Twitch for queries under two characters", async () => {
  const fetchImpl = stub(() => ({ data: {} }));
  expect(await twitchGames(fetchImpl).find("  e ")).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("find puts an id match first and does not list it twice", async () => {
  const fetchImpl = stub((body) => body.query.includes("game(id")
    ? { data: { game: node("512953", "ELDEN RING") } }
    : { data: { searchCategories: { edges: [
        { node: node("5129530", "Some Other Game") },
        { node: node("512953", "ELDEN RING") },
      ] } } });
  const found = await twitchGames(fetchImpl).find("512953");
  expect(found.map((g) => g.id)).toEqual(["512953", "5129530"]);
});

test("find asks only the search for a non-numeric query", async () => {
  const fetchImpl = stub(() => ({ data: { searchCategories: { edges: [] } } }));
  await twitchGames(fetchImpl).find("rust");
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
