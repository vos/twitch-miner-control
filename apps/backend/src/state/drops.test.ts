import { expect, test, vi } from "vitest";
import { DropsCache, DROPS_TTL_MS } from "./drops.js";

let clock = 1_000_000;

function make(
  responses: unknown[],
  eligible = (_l: string) => true,
  allowsUnlinked = (_l: string) => false,
) {
  clock = 1_000_000;
  const queue = [...responses];
  const request = vi.fn(async (_op: string, _params?: object) => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { drops: {} };
  });
  const cache = new DropsCache({
    client: { request } as never,
    eligible,
    allowsUnlinked,
    now: () => clock,
  });
  return { cache, request };
}

const drop = (over: object = {}) => ({
  name: "Crate", minutes: 45, required: 60, claimable: false, ...over,
});

test("reports the next drop for an eligible live channel", async () => {
  const { cache } = make([{ drops: { alpha: drop() } }]);
  const out = await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(out.get("alpha")).toEqual(drop());
});

test("asks the helper only for channels claiming drops", async () => {
  // The setting is the precondition: with claim_drops off the miner is
  // not syncing campaigns, so there is nothing to read and the call
  // would be spent on nothing.
  const { cache, request } = make(
    [{ drops: {} }],
    (login) => login === "alpha",
  );
  await cache.resolve([
    { username: "alpha", channelId: "42" },
    { username: "beta", channelId: "43" },
  ]);
  expect(request).toHaveBeenCalledWith("drops", {
    streamers: { alpha: "42" }, allowUnlinked: [],
  });
});

test("names the channels whose mode progresses unlinked campaigns", async () => {
  // Under LINKED the miner skips an unlinked campaign, so the helper has
  // to leave it off that channel's card.
  const { cache, request } = make(
    [{ drops: {} }],
    () => true,
    (login) => login === "alpha",
  );
  await cache.resolve([
    { username: "Alpha", channelId: "42" },
    { username: "beta", channelId: "43" },
  ]);
  expect(request).toHaveBeenCalledWith("drops", {
    streamers: { alpha: "42", beta: "43" }, allowUnlinked: ["alpha"],
  });
});

test("makes no request at all when nothing is eligible", async () => {
  const { cache, request } = make([], () => false);
  const out = await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(request).not.toHaveBeenCalled();
  expect(out.size).toBe(0);
});

test("serves a cached drop inside the TTL", async () => {
  const { cache, request } = make([{ drops: { alpha: drop() } }]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  clock += DROPS_TTL_MS - 1;
  const out = await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(request).toHaveBeenCalledOnce();
  expect(out.get("alpha")).toEqual(drop());
});

test("refetches once the TTL lapses", async () => {
  const { cache, request } = make([
    { drops: { alpha: drop({ minutes: 45 }) } },
    { drops: { alpha: drop({ minutes: 55 }) } },
  ]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  clock += DROPS_TTL_MS + 1;
  const out = await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(out.get("alpha")?.minutes).toBe(55);
});

test("asks straight away about a channel that joins inside the TTL", async () => {
  // Going live, or being switched on, must not wait out another channel's
  // clock: never asked is not the same as asked and found nothing.
  const { cache, request } = make([
    { drops: { alpha: drop() } },
    { drops: { beta: drop({ name: "Charm" }) } },
  ]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  clock += 1_000;
  const out = await cache.resolve([
    { username: "alpha", channelId: "42" },
    { username: "beta", channelId: "43" },
  ]);
  expect(request).toHaveBeenLastCalledWith("drops", {
    streamers: { beta: "43" }, allowUnlinked: [],
  });
  expect(out.get("alpha")).toEqual(drop());
  expect(out.get("beta")?.name).toBe("Charm");
});

test("each channel keeps its own TTL", async () => {
  const { cache, request } = make([
    { drops: { alpha: drop() } },
    { drops: { beta: drop() } },
    { drops: { alpha: drop({ minutes: 55 }) } },
  ]);
  const both = [
    { username: "alpha", channelId: "42" },
    { username: "beta", channelId: "43" },
  ];
  await cache.resolve(both.slice(0, 1));
  clock += DROPS_TTL_MS - 1;
  await cache.resolve(both);
  clock += 2;
  const out = await cache.resolve(both);
  expect(request).toHaveBeenLastCalledWith("drops", {
    streamers: { alpha: "42" }, allowUnlinked: [],
  });
  expect(out.get("alpha")?.minutes).toBe(55);
});

test("keeps a channel's answer of no drop for the TTL", async () => {
  const { cache, request } = make([{ drops: { alpha: null } }]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  clock += DROPS_TTL_MS - 1;
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(request).toHaveBeenCalledOnce();
});

test("a failed lookup is tried again on the next pass", async () => {
  const { cache, request } = make([
    new Error("helper exploded"),
    { drops: { alpha: drop() } },
  ]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  const out = await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(out.get("alpha")).toEqual(drop());
});

test("a helper failure leaves the last known drop standing", async () => {
  // Drops are decoration on a dashboard whose job is balances: a failed
  // lookup must never take a refresh down with it.
  const { cache } = make([
    { drops: { alpha: drop() } },
    new Error("helper exploded"),
  ]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  clock += DROPS_TTL_MS + 1;
  const out = await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(out.get("alpha")).toEqual(drop());
});

test("forgets a channel that stops reporting a drop", async () => {
  // A finished campaign must clear, or the card keeps a bar for a drop
  // that can no longer be earned.
  const { cache } = make([
    { drops: { alpha: drop() } },
    { drops: { alpha: null } },
  ]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  clock += DROPS_TTL_MS + 1;
  const out = await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(out.get("alpha") ?? null).toBeNull();
});

test("drops a channel that becomes ineligible", async () => {
  // Turning claim_drops off must clear the badge rather than leave the
  // last value frozen on the card forever.
  let on = true;
  const { cache } = make([{ drops: { alpha: drop() } }], () => on);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  on = false;
  const out = await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(out.get("alpha") ?? null).toBeNull();
});

test("skips a channel with no known channel id", async () => {
  // The campaign progress query is keyed by channel id; without one there
  // is nothing to ask for.
  const { cache, request } = make([{ drops: {} }]);
  await cache.resolve([{ username: "alpha", channelId: null }]);
  expect(request).not.toHaveBeenCalled();
});

test("normalises logins so config and live state agree", async () => {
  const { cache } = make([{ drops: { alpha: drop() } }]);
  const out = await cache.resolve([{ username: "Alpha", channelId: "42" }]);
  expect(out.get("alpha")).toEqual(drop());
});

const seen = (over: object = {}) => ({
  id: "d1", name: "Crate", minutes: 46, required: 60, benefits: ["Charm"], endsAt: 5, ...over,
});

test("a progress event moves the held drop without asking Twitch", async () => {
  const { cache, request } = make([{ drops: { alpha: drop({ id: "d1", minutes: 45 }) } }]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(cache.observe("alpha", seen())?.minutes).toBe(46);
  const out = await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(out.get("alpha")?.minutes).toBe(46);
  expect(request).toHaveBeenCalledOnce();
});

test("a progress event keeps what only the helper knows about the drop", async () => {
  const { cache } = make([{ drops: { alpha: drop({
    id: "d1", linked: false, linkUrl: "https://example.com", claimable: false,
  }) } }]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(cache.observe("alpha", seen())).toMatchObject({
    linked: false, linkUrl: "https://example.com",
  });
});

test("a progress event does not reset the clock that rereads Twitch", async () => {
  // The helper's answer also carries the claimable state, which progress
  // events do not, so the TTL keeps running underneath them.
  const { cache, request } = make([
    { drops: { alpha: drop({ id: "d1" }) } },
    { drops: { alpha: drop({ id: "d1", claimable: true }) } },
  ]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  clock += DROPS_TTL_MS - 1;
  cache.observe("alpha", seen());
  clock += 2;
  const out = await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(out.get("alpha")?.claimable).toBe(true);
});

test("the drop the miner is actually progressing replaces another on the badge", async () => {
  const { cache } = make([{ drops: { alpha: drop({ id: "d1", linked: false }) } }]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(cache.observe("alpha", seen({ id: "d2", name: "Hat" }))).toMatchObject({
    id: "d2", name: "Hat", claimable: false, linked: false,
  });
});

test("a progress event fills in a channel asked about and found empty", async () => {
  const { cache } = make([{ drops: { alpha: null } }]);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  expect(cache.observe("alpha", seen())).toMatchObject({ id: "d1", linked: true });
});

test("a progress event for a channel never asked about waits for the helper", async () => {
  // Only the helper can say whether the account is linked.
  const { cache } = make([]);
  expect(cache.observe("alpha", seen())).toBeNull();
});

test("a progress event for a channel not claiming drops is ignored", async () => {
  let on = true;
  const { cache } = make([{ drops: { alpha: drop({ id: "d1" }) } }], () => on);
  await cache.resolve([{ username: "alpha", channelId: "42" }]);
  on = false;
  expect(cache.observe("alpha", seen())).toBeNull();
});

test("a claim forgets the drop on every channel holding it", async () => {
  // Campaigns span channels, and the claim event names no channel.
  const { cache, request } = make([
    { drops: { alpha: drop({ id: "d1" }), beta: drop({ id: "d1" }) } },
    { drops: { alpha: drop({ id: "d2", name: "Next" }), beta: drop({ id: "d2", name: "Next" }) } },
  ]);
  const both = [
    { username: "alpha", channelId: "42" }, { username: "beta", channelId: "43" },
  ];
  await cache.resolve(both);
  cache.forget("d1");
  const out = await cache.resolve(both);
  expect(request).toHaveBeenCalledTimes(2);
  expect(out.get("alpha")?.name).toBe("Next");
});
