import { expect, test, vi } from "vitest";
import { extractCampaigns, fetchCampaigns } from "./campaignSource.js";

/**
 * A miniature of the real payload: the campaigns array is embedded in a
 * React Server Component stream, surrounded by rendered markup, and its
 * dates carry the `$D` marker the RSC format prefixes them with.
 */
const payload = (inner: string) =>
  `3:["$","div",null,{"className":"x","children":"All drop campaigns"}]
4:["$","$L25",null,{"campaigns":${inner},"total":2}]
5:["$","footer",null,{}]`;

const campaign = `[{
  "id":"c1","name":"Console Launch Drops","gameId":"1441208453",
  "startAt":"$D2026-08-25T18:00:00.000Z","endAt":"$D2026-09-22T17:59:59.999Z",
  "game":{"id":"1441208453","displayName":"Once Human","slug":"once-human"},
  "timeBasedDrops":[
    {"id":"d1","name":"DECAL: GRAFFITI","requiredMinutesWatched":60,
     "requiresSub":false,
     "benefits":[{"benefitId":"b1","name":"Graffiti Decal"}]},
    {"id":"d2","name":"Supporter Crate","requiredMinutesWatched":240,
     "requiresSub":true,
     "benefits":[{"benefitId":"b2","name":"Crate"}]}
  ]}]`;

test("pulls campaigns out of the surrounding RSC stream", () => {
  const out = extractCampaigns(payload(campaign));
  expect(out).toHaveLength(1);
  expect(out[0]?.name).toBe("Console Launch Drops");
  expect(out[0]?.game?.displayName).toBe("Once Human");
});

test("strips the RSC date marker and converts to epoch ms", () => {
  // "$D2026-08-25T…" is not a date any parser accepts as-is.
  const [out] = extractCampaigns(payload(campaign));
  expect(out?.startsAt).toBe(Date.parse("2026-08-25T18:00:00.000Z"));
  expect(out?.endsAt).toBe(Date.parse("2026-09-22T17:59:59.999Z"));
});

test("maps drops onto the shape the rest of the app already uses", () => {
  const [out] = extractCampaigns(payload(campaign));
  expect(out?.drops[0]).toEqual({
    id: "d1",
    name: "DECAL: GRAFFITI",
    benefits: ["Graffiti Decal"],
    requiredMinutes: 60,
    requiredSubs: 0,
  });
});

test("carries requiresSub through as the sub requirement", () => {
  // The rest of the app reads requiredSubs > 0 as unobtainable, so the
  // boolean has to become a count rather than being dropped.
  const [out] = extractCampaigns(payload(campaign));
  expect(out?.drops[1]?.requiredSubs).toBe(1);
});

test("survives a campaign with no game reported", () => {
  const out = extractCampaigns(
    payload(`[{"id":"c1","name":"Bare","startAt":"$D2026-01-01T00:00:00.000Z",
      "endAt":"$D2026-02-01T00:00:00.000Z","timeBasedDrops":[]}]`),
  );
  expect(out[0]?.game).toBeNull();
  expect(out[0]?.drops).toEqual([]);
});

test("survives a drop with no benefits listed", () => {
  const out = extractCampaigns(
    payload(`[{"id":"c1","name":"X","startAt":"$D2026-01-01T00:00:00.000Z",
      "endAt":"$D2026-02-01T00:00:00.000Z","game":null,
      "timeBasedDrops":[{"id":"d1","name":"Thing","requiredMinutesWatched":30}]}]`),
  );
  expect(out[0]?.drops[0]?.benefits).toEqual([]);
  expect(out[0]?.drops[0]?.requiredSubs).toBe(0);
});

test("handles a bracket inside a string without truncating", () => {
  // The scan is string-aware: a "]" inside a campaign name must not be
  // mistaken for the end of the array.
  const out = extractCampaigns(
    payload(`[{"id":"c1","name":"Drops [Week 2]","startAt":"$D2026-01-01T00:00:00.000Z",
      "endAt":"$D2026-02-01T00:00:00.000Z","game":null,"timeBasedDrops":[]}]`),
  );
  expect(out).toHaveLength(1);
  expect(out[0]?.name).toBe("Drops [Week 2]");
});

test("throws when the payload carries no campaigns array", () => {
  // The source's format changed, or we were served something else
  // entirely. Throwing lets the catalogue mark itself unavailable rather
  // than reporting an empty list as fact.
  expect(() => extractCampaigns("<html>nothing here</html>")).toThrow(/campaign/i);
});

test("throws on a campaigns array that is not valid JSON", () => {
  expect(() => extractCampaigns(`x:{"campaigns":[{"id":`)).toThrow();
});

test("fetches with the RSC header the source needs", async () => {
  // Without it the server returns rendered HTML with no data in it.
  const impl = vi.fn(async () => ({
    ok: true, status: 200, text: async () => payload(campaign),
  })) as unknown as typeof fetch;
  const out = await fetchCampaigns({ fetchImpl: impl });
  expect(out).toHaveLength(1);
  const init = vi.mocked(impl).mock.calls[0]?.[1];
  expect((init?.headers as Record<string, string>)["RSC"]).toBe("1");
});

test("throws on a non-ok response rather than returning nothing", async () => {
  const impl = vi.fn(async () => ({
    ok: false, status: 503, text: async () => "",
  })) as unknown as typeof fetch;
  await expect(fetchCampaigns({ fetchImpl: impl })).rejects.toThrow(/503/);
});
