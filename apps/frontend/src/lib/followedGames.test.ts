import { expect, test } from "vitest";
import { followSummary, runningCampaigns, skippedCampaigns, viaGameName } from "./followedGames.js";

const NOW = 10_000;
const c = (id: string, gameId: string | null, endsAt: number | null = NOW + 1) => ({
  id, name: id,
  game: gameId === null ? null : { id: gameId, slug: gameId, displayName: `Game ${gameId}` },
  startsAt: 1, endsAt, drops: [], status: "untouched", complete: false,
}) as never;

test("runningCampaigns counts a game's campaigns that have not ended", () => {
  expect(runningCampaigns("g1", [c("a", "g1"), c("b", "g1", NOW), c("x", "g2")], NOW)).toBe(1);
});

test("followSummary says what following did", () => {
  const rust = { id: "1", name: "Rust", slug: "rust", boxArtUrl: null };
  expect(followSummary({ added: [rust], alreadyFollowed: [], notFound: [] }, 2, 2))
    .toBe("Following Rust · 2 campaigns subscribed");
  expect(followSummary({ added: [rust, { ...rust, id: "2" }], alreadyFollowed: [], notFound: ["9"] }, 0, 0))
    .toBe("Following 2 games · no campaigns running right now · 1 not found on Twitch");
  expect(followSummary({ added: [], alreadyFollowed: ["1"], notFound: [] }, 0, 0))
    .toBe("Already following");
});

test("followSummary tells running campaigns with nothing to add from none running", () => {
  // Already collected, not earned by watching, or subscribed by hand: they
  // run, but following adds nothing -- which is not "none running".
  const rust = { id: "1", name: "Rust", slug: "rust", boxArtUrl: null };
  expect(followSummary({ added: [rust], alreadyFollowed: [], notFound: [] }, 0, 2))
    .toBe("Following Rust · 2 campaigns running, none left to subscribe to");
  expect(followSummary({ added: [rust], alreadyFollowed: [], notFound: [] }, 0, 1))
    .toBe("Following Rust · 1 campaign running, none left to subscribe to");
});

test("viaGameName prefers the followed game, then the catalogue", () => {
  const followed = [{ id: "g1", name: "ELDEN RING", slug: "", boxArtUrl: null, poolSize: 3, skipped: [] }];
  expect(viaGameName("g1", followed, [])).toBe("ELDEN RING");
  expect(viaGameName("g2", followed, [c("a", "g2")])).toBe("Game g2");
  expect(viaGameName("g3", followed, [])).toBeNull();
});

test("skippedCampaigns lists what a followed game skipped and could still collect", () => {
  const followed = [{
    id: "g1", name: "ELDEN RING", slug: "", boxArtUrl: null, poolSize: 3,
    skipped: ["live", "ended", "done", "subbed", "gone"],
  }];
  const campaigns = [
    c("live", "g1"),
    c("ended", "g1", NOW),
    { ...(c("done", "g1") as object), complete: true },
    c("subbed", "g1"),
  ] as never[];
  const out = skippedCampaigns(followed, campaigns, [{ targetId: "subbed" }], NOW);
  // Ended and complete campaigns are skipped for good, a subscribed one is
  // already being collected, and one gone from the catalogue has no name.
  expect(out.map((s) => [s.game.id, s.campaign.id])).toEqual([["g1", "live"]]);
});
