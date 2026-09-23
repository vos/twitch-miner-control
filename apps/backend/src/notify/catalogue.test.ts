import { expect, test } from "vitest";
import { ALL_KINDS, CATALOGUE, GROUPS, LISTED, NOTIFY_KIND, kindInfo } from "./catalogue.js";

test("every kind has exactly one catalogue entry", () => {
  expect(CATALOGUE.map((k) => k.kind).sort()).toEqual([...ALL_KINDS].sort());
});

test("every entry belongs to a known group", () => {
  const groups = new Set(GROUPS.map((g) => g.id));
  for (const info of CATALOGUE) expect(groups.has(info.group)).toBe(true);
});

test("the defaults match the spec", () => {
  const on = CATALOGUE.filter((k) => k.defaultOn && k.kind !== NOTIFY_KIND.TEST).map((k) => k.kind);
  expect(on.sort()).toEqual([
    "app.update", "campaign.completed", "campaign.endingSoon", "drop.claimed",
    "gift.received", "miner.crashed", "restart.pending", "twitch.signedOut",
  ]);
});

test("high-volume kinds stay out of the inbox", () => {
  for (const kind of ["streamer.online", "streamer.offline", "prediction.won", "raid.joined"] as const) {
    expect(kindInfo(kind).inbox).toBe(false);
  }
});

test("the test kind is not offered as a preference", () => {
  expect(LISTED.some((k) => k.kind === NOTIFY_KIND.TEST)).toBe(false);
  expect(LISTED).toHaveLength(CATALOGUE.length - 1);
});

test("a restart pending is short-lived and urgent", () => {
  expect(kindInfo(NOTIFY_KIND.RESTART_PENDING)).toMatchObject({ urgency: "high", ttlSeconds: 90 });
});
