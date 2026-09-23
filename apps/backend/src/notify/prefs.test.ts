import { expect, test } from "vitest";
import { NOTIFY_KIND } from "./catalogue.js";
import {
  defaultPrefs, inQuietHours, kindEnabled, localClock, prefsSchema, wants, wantsKind,
  type Prefs,
} from "./prefs.js";

const BERLIN = "Europe/Berlin";
// 2026-09-23 is summer time in Berlin (UTC+2) and New York (UTC-4).
const utc = (hour: number, minute = 0, day = 23) => Date.UTC(2026, 8, day, hour, minute);

const prefs = (over: Partial<Prefs> = {}): Prefs => ({ ...defaultPrefs(BERLIN), ...over });

test("an untouched kind follows the catalogue default", () => {
  expect(kindEnabled(prefs(), NOTIFY_KIND.MINER_CRASHED)).toBe(true);
  expect(kindEnabled(prefs(), NOTIFY_KIND.STREAMER_ONLINE)).toBe(false);
});

test("an explicit toggle beats the default", () => {
  const p = prefs({ kinds: { "miner.crashed": false, "streamer.online": true } });
  expect(kindEnabled(p, NOTIFY_KIND.MINER_CRASHED)).toBe(false);
  expect(kindEnabled(p, NOTIFY_KIND.STREAMER_ONLINE)).toBe(true);
});

test("the local clock is read in the destination's zone", () => {
  expect(localClock(utc(22, 30), BERLIN)).toEqual({ date: "2026-09-24", minutes: 30 });
  expect(localClock(utc(22, 30), "America/New_York")).toEqual({ date: "2026-09-23", minutes: 18 * 60 + 30 });
});

test("quiet hours can cross midnight", () => {
  const q = { from: "22:00", to: "07:00", allowHealth: false };
  expect(inQuietHours(q, BERLIN, utc(21, 30))).toBe(true); // 23:30
  expect(inQuietHours(q, BERLIN, utc(4, 30))).toBe(true); // 06:30
  expect(inQuietHours(q, BERLIN, utc(6, 30))).toBe(false); // 08:30
  expect(inQuietHours(q, "America/New_York", utc(21, 30))).toBe(false); // 17:30
});

test("quiet hours inside one day", () => {
  const q = { from: "13:00", to: "14:00", allowHealth: false };
  expect(inQuietHours(q, BERLIN, utc(11, 30))).toBe(true); // 13:30
  expect(inQuietHours(q, BERLIN, utc(12, 0))).toBe(false); // 14:00, end is exclusive
});

test("equal ends mean no quiet hours at all", () => {
  expect(inQuietHours({ from: "08:00", to: "08:00", allowHealth: false }, BERLIN, utc(6))).toBe(false);
});

test("quiet hours silence everything unless health is let through", () => {
  const night = utc(21, 30);
  const strict = prefs({ quietHours: { from: "22:00", to: "07:00", allowHealth: false } });
  const lenient = prefs({ quietHours: { from: "22:00", to: "07:00", allowHealth: true } });
  expect(wantsKind(strict, NOTIFY_KIND.MINER_CRASHED, night)).toBe(false);
  expect(wantsKind(lenient, NOTIFY_KIND.MINER_CRASHED, night)).toBe(true);
  expect(wantsKind(lenient, NOTIFY_KIND.DROP_CLAIMED, night)).toBe(false);
});

test("the streamer filter applies to the streamers group only", () => {
  const p = prefs({
    kinds: { "streamer.online": true },
    streamers: ["Alpha"],
  });
  const online = (login: string) => ({
    kind: NOTIFY_KIND.STREAMER_ONLINE, streamer: { login, name: login },
  });
  expect(wants(p, online("alpha"), utc(12))).toBe(true);
  expect(wants(p, online("beta"), utc(12))).toBe(false);
  expect(wants(p, { kind: NOTIFY_KIND.STREAMER_ONLINE }, utc(12))).toBe(false);
  expect(wants(p, { kind: NOTIFY_KIND.DROP_CLAIMED }, utc(12))).toBe(true);
});

test("the schema accepts the defaults and rejects nonsense", () => {
  expect(prefsSchema.safeParse(defaultPrefs(BERLIN)).success).toBe(true);
  expect(prefsSchema.safeParse({ ...defaultPrefs(BERLIN), kinds: { nope: true } }).success).toBe(false);
  expect(prefsSchema.safeParse({ ...defaultPrefs(BERLIN), timeZone: "Mars/Olympus" }).success).toBe(false);
  expect(prefsSchema.safeParse({ ...defaultPrefs(BERLIN), digestAt: "24:00" }).success).toBe(false);
});

test("an unknown zone at registration falls back to the server's", () => {
  expect(defaultPrefs("Mars/Olympus").timeZone).toBe(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
});
