import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { GiftSubsCache, watchGiftSubs, type GiftSub } from "./giftSubs.js";

const DAY = 86_400_000;
const START = 1_000_000;
let clock = START;

function gift(over: Partial<GiftSub> = {}): GiftSub {
  return {
    id: "g1",
    tier: 1,
    product: "KDRkitten Sub",
    gifter: { login: "badbeard95", displayName: "BadBeard95" },
    target: { channelId: "42", login: "kdrkitten", displayName: "KDRkitten" },
    endsAt: START + 9 * DAY,
    ...over,
  };
}

function make(responses: unknown[]) {
  clock = START;
  const queue = [...responses];
  const request = vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? { giftSubs: [] };
  });
  const cache = new GiftSubsCache({ client: { request } as never, now: () => clock });
  return { cache, request };
}

test("holds nothing until the first fetch", () => {
  const { cache, request } = make([]);
  expect(cache.active()).toEqual([]);
  expect(request).not.toHaveBeenCalled();
});

test("a refresh fetches the account's gift subs", async () => {
  const { cache, request } = make([{ giftSubs: [gift()] }]);
  const out = await cache.refresh();
  expect(request).toHaveBeenCalledWith("gift_subs");
  expect(out).toEqual({ giftSubs: [gift()], error: null });
  expect(cache.active()).toEqual([gift()]);
});

test("a gift past its end drops out without a refetch", async () => {
  // The miner sends no event when a gift expires, so nothing would
  // trigger a fetch -- the end date is the only signal there is.
  const { cache, request } = make([{ giftSubs: [gift({ endsAt: START + DAY })] }]);
  await cache.refresh();
  clock += DAY;
  expect(cache.active()).toEqual([]);
  expect(request).toHaveBeenCalledTimes(1);
});

test("a failed refresh keeps the last list and reports the error", async () => {
  const { cache } = make([{ giftSubs: [gift()] }, new Error("gql exploded")]);
  await cache.refresh();
  const out = await cache.refresh();
  expect(out.giftSubs).toEqual([gift()]);
  expect(out.error).toMatch(/try again/i);
  expect(cache.active()).toEqual([gift()]);
});

test("a failure reports a sentence, never the helper's traceback", async () => {
  // A GQL failure's message is three stacked Python tracebacks; the
  // dashboard shows this text as is.
  const { cache } = make([new Error("GQL Operation failed all 3 attempts, errors: [Traceback ...")]);
  expect((await cache.refresh()).error).not.toMatch(/Traceback/);
});

test("a dead Twitch session says to sign in again", async () => {
  const { cache } = make([Object.assign(new Error("401 Client Error"), { code: "AUTH" })]);
  expect((await cache.refresh()).error).toMatch(/sign in/i);
});

test("the next good refresh clears the error", async () => {
  const { cache } = make([new Error("gql exploded"), { giftSubs: [] }]);
  await cache.refresh();
  expect((await cache.refresh()).error).toBeNull();
});

test("overlapping refreshes share one fetch", async () => {
  const { cache, request } = make([{ giftSubs: [gift()] }]);
  await Promise.all([cache.refresh(), cache.refresh()]);
  expect(request).toHaveBeenCalledTimes(1);
});

test("announces a change only when the list actually changed", async () => {
  const { cache } = make([
    { giftSubs: [gift()] },
    { giftSubs: [gift()] },
    { giftSubs: [] },
  ]);
  const onChange = vi.fn();
  cache.on("change", onChange);
  await cache.refresh();
  await cache.refresh();
  expect(onChange).toHaveBeenCalledTimes(1);
  await cache.refresh();
  expect(onChange).toHaveBeenCalledTimes(2);
});

test("a failure does not announce a change", async () => {
  const { cache } = make([new Error("gql exploded")]);
  const onChange = vi.fn();
  cache.on("change", onChange);
  await cache.refresh();
  expect(onChange).not.toHaveBeenCalled();
});

test("forChannel matches on channel id", async () => {
  const { cache } = make([{ giftSubs: [gift()] }]);
  await cache.refresh();
  expect(cache.forChannel("42", "someone-else")).toEqual(gift());
  expect(cache.forChannel("43", "other")).toBeNull();
});

test("forChannel falls back to the login when the id is not known yet", async () => {
  // A card painted from the database has no channel id until the live
  // pass lands, and the badge should not pop in a moment later.
  const { cache } = make([{ giftSubs: [gift()] }]);
  await cache.refresh();
  expect(cache.forChannel(null, "KDRkitten")).toEqual(gift());
});

test("forChannel never matches a non-channel gift", async () => {
  const { cache } = make([{ giftSubs: [gift({ target: null, product: "Twitch Turbo" })] }]);
  await cache.refresh();
  expect(cache.forChannel(null, "turbo")).toBeNull();
});

function watched() {
  const giftSubs = { refresh: vi.fn(async () => ({ giftSubs: [], error: null })) };
  const supervisor = new EventEmitter();
  const stateService = new EventEmitter();
  watchGiftSubs({ giftSubs, supervisor, stateService });
  return { refresh: giftSubs.refresh, supervisor, stateService };
}

test("refetches when the miner reports a new gift", () => {
  const { refresh, stateService } = watched();
  stateService.emit("event", { ts: 1, type: "GIFT_SUB_RECEIVED", message: "Tier-1 Gift Sub" });
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("ignores every other doorbell event", () => {
  const { refresh, stateService } = watched();
  stateService.emit("event", { ts: 1, type: "GAIN_FOR_WATCH", message: null });
  expect(refresh).not.toHaveBeenCalled();
});

test("refetches each time the miner starts running", () => {
  // Its first sync after a start is silent, so a gift that arrived while
  // it was down would otherwise never show.
  const { refresh, supervisor } = watched();
  supervisor.emit("state", "STARTING");
  supervisor.emit("state", "RUNNING");
  supervisor.emit("state", "STOPPED");
  supervisor.emit("state", "RUNNING");
  expect(refresh).toHaveBeenCalledTimes(2);
});
