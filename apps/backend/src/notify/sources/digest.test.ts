import { expect, test, vi } from "vitest";
import type { DaySummary } from "../../insights/recap.js";
import { defaultPrefs } from "../prefs.js";
import type { Destination } from "../store.js";
import type { GiftSub } from "../../state/giftSubs.js";
import { DigestScheduler, digestNotification, giftEndingNotification } from "./digest.js";

const summary = (over: Partial<DaySummary> = {}): DaySummary => ({
  day: "2026-09-23", earned: 12_400, minedMs: 6.5 * 3_600_000, dropsClaimed: 2,
  top: { login: "alpha", displayName: "Alpha", earned: 4_100 }, hasData: true, ...over,
});

const dest = (over: Partial<Destination> = {}): Destination => ({
  id: "d1", channel: "webpush", label: "Phone", endpoint: "e", subscription: null,
  prefs: { ...defaultPrefs("Europe/Berlin"), kinds: { "digest.daily": true } },
  enabled: true, createdTs: 1, lastOkTs: null, lastError: null, lastErrorTs: null, ...over,
});

function harness(destinations: Destination[], day = summary(), gifts: GiftSub[] = []) {
  let now = 0;
  const seen = new Set<string>();
  const sendTo = vi.fn(async () => ({ ok: true as const }));
  const summaryFn = vi.fn(() => day);
  const scheduler = new DigestScheduler({
    notifier: { sendTo, markSeen: (k: string) => (seen.has(k) ? false : (seen.add(k), true)) },
    store: { list: () => destinations },
    summary: summaryFn,
    giftSubs: () => gifts,
    now: () => now,
  });
  return { scheduler, sendTo, summaryFn, at: (ms: number) => { now = ms; } };
}

test("the digest goes out once a local day, at or after its time", () => {
  const h = harness([dest()]);
  h.at(Date.UTC(2026, 8, 24, 6, 59)); // 08:59 in Berlin
  h.scheduler.tick();
  expect(h.sendTo).not.toHaveBeenCalled();
  h.at(Date.UTC(2026, 8, 24, 7, 0)); // 09:00
  h.scheduler.tick();
  h.at(Date.UTC(2026, 8, 24, 7, 1));
  h.scheduler.tick();
  expect(h.sendTo).toHaveBeenCalledTimes(1);
  expect(h.summaryFn).toHaveBeenCalledWith("2026-09-23");
  h.at(Date.UTC(2026, 8, 25, 7, 0));
  h.scheduler.tick();
  expect(h.sendTo).toHaveBeenCalledTimes(2);
});

test("off, paused or empty means nothing is sent", () => {
  const off = harness([dest({ prefs: defaultPrefs("Europe/Berlin") })]);
  const paused = harness([dest({ enabled: false })]);
  const empty = harness([dest()], summary({ hasData: false }));
  for (const h of [off, paused, empty]) {
    h.at(Date.UTC(2026, 8, 24, 8));
    h.scheduler.tick();
    expect(h.sendTo).not.toHaveBeenCalled();
  }
});

test("the digest reads as one line of figures", () => {
  expect(digestNotification(summary())).toEqual({
    kind: "digest.daily", title: "Yesterday's mining",
    body: "+12.4K points · 2 drops claimed · 6.5 h mined · Top: Alpha +4.1K",
    link: "/?open=insights",
  });
  expect(digestNotification(summary({ dropsClaimed: 0, top: null })).body)
    .toBe("+12.4K points · 6.5 h mined");
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 09:00 in Berlin, the default digest time.
const DIGEST = Date.UTC(2026, 9, 4, 7, 0);

const gift = (over: Partial<GiftSub> = {}): GiftSub => ({
  id: "g1", tier: 1, product: "KDRkitten Sub",
  gifter: { login: "badbeard95", displayName: "BadBeard95" },
  target: { channelId: "42", login: "kdrkitten", displayName: "KDRkitten" },
  endsAt: DIGEST + 2 * DAY,
  ...over,
});

/** Gift reminders only: the digest itself left at its default, off. */
const giftDest = (over: Partial<Destination> = {}) =>
  dest({ prefs: defaultPrefs("Europe/Berlin"), ...over });

const giftSends = (h: ReturnType<typeof harness>) =>
  h.sendTo.mock.calls.filter((c) => (c as unknown[])[1] !== undefined
    && ((c as unknown[])[1] as { kind: string }).kind === "gift.endingSoon");

test("a gift ending within three days is announced at digest time", () => {
  const h = harness([giftDest()], summary(), [gift()]);
  h.at(DIGEST - 60_000);
  h.scheduler.tick();
  expect(giftSends(h)).toHaveLength(0);
  h.at(DIGEST);
  h.scheduler.tick();
  expect(giftSends(h)).toHaveLength(1);
});

test("the reminder does not need the digest turned on", () => {
  // Its own kind on the digest's clock: most people never enable the digest.
  const h = harness([giftDest()], summary(), [gift()]);
  h.at(DIGEST);
  h.scheduler.tick();
  expect(h.sendTo).toHaveBeenCalledTimes(1);
  expect(giftSends(h)).toHaveLength(1);
});

test("a gift is announced once, not every morning", () => {
  const h = harness([giftDest()], summary(), [gift()]);
  h.at(DIGEST);
  h.scheduler.tick();
  h.at(DIGEST + 60_000);
  h.scheduler.tick();
  h.at(DIGEST + DAY);
  h.scheduler.tick();
  expect(giftSends(h)).toHaveLength(1);
});

test("a gift further out waits for the digest that finds it inside three days", () => {
  const h = harness([giftDest()], summary(), [gift({ endsAt: DIGEST + 3 * DAY + HOUR })]);
  h.at(DIGEST);
  h.scheduler.tick();
  expect(giftSends(h)).toHaveLength(0);
  // It crosses the three-day mark at 10:00 today; that is not digest
  // time, so it waits for tomorrow's rather than pinging mid-morning.
  h.at(DIGEST + 2 * HOUR);
  h.scheduler.tick();
  expect(giftSends(h)).toHaveLength(0);
  h.at(DIGEST + DAY);
  h.scheduler.tick();
  expect(giftSends(h)).toHaveLength(1);
});

test("one reminder lists every gift due that morning", () => {
  const h = harness([giftDest()], summary(), [
    gift(), gift({ id: "g2", target: null, tier: "Custom", product: "Twitch Turbo", gifter: null }),
  ]);
  h.at(DIGEST);
  h.scheduler.tick();
  const [call] = giftSends(h);
  const n = (call as unknown[])[1] as { title: string; body: string };
  expect(n.title).toBe("2 gift subs ending soon");
  expect(n.body).toContain("KDRkitten");
  expect(n.body).toContain("Twitch Turbo");
});

test("turned off or paused means no reminder", () => {
  const off = harness(
    [giftDest({ prefs: { ...defaultPrefs("Europe/Berlin"), kinds: { "gift.endingSoon": false } } })],
    summary(), [gift()],
  );
  const paused = harness([giftDest({ enabled: false })], summary(), [gift()]);
  for (const h of [off, paused]) {
    h.at(DIGEST);
    h.scheduler.tick();
    expect(h.sendTo).not.toHaveBeenCalled();
  }
});

test("each destination is reminded on its own", () => {
  const h = harness([giftDest(), giftDest({ id: "d2" })], summary(), [gift()]);
  h.at(DIGEST);
  h.scheduler.tick();
  expect(giftSends(h)).toHaveLength(2);
});

test("the reminder names the channel, the tier, the gifter and the time left", () => {
  expect(giftEndingNotification([gift()], DIGEST)).toEqual({
    kind: "gift.endingSoon",
    title: "Gift sub ending soon",
    body: "KDRkitten: Tier 1 gift sub from BadBeard95 ends in 2d",
    link: "/?open=dashboard",
  });
});

test("the reminder counts hours in the last two days", () => {
  const n = giftEndingNotification([gift({ endsAt: DIGEST + 20 * HOUR, gifter: null })], DIGEST);
  expect(n.body).toBe("KDRkitten: Tier 1 gift sub ends in 20h");
});
