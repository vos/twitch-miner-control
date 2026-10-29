import { expect, test } from "vitest";
import { BET_FIELDS, SETTINGS_FIELDS, describeDefault } from "./settingsFields.js";

test("covers every upstream StreamerSettings field", () => {
  expect(new Set(SETTINGS_FIELDS.map((f) => f.key))).toEqual(new Set([
    "makePredictions", "followRaid", "claimDrops", "claimMoments",
    "watchStreak", "communityGoals", "weeklyRewards",
    "pointsLimit", "chat", "simulateHlsPlayback",
  ]));
});

test("covers every BetSettings field", () => {
  expect(new Set(BET_FIELDS.map((f) => f.key))).toEqual(new Set([
    "strategy", "percentage", "percentageGap", "maxPoints",
    "minimumPoints", "stealthMode", "delay", "delayMode",
  ]));
});

test("carries upstream's own defaults, including the false ones", () => {
  const by = (key: string) =>
    [...SETTINGS_FIELDS, ...BET_FIELDS].find((f) => f.key === key);
  expect(by("watchStreak")?.defaultValue).toBe(true);
  expect(by("communityGoals")?.defaultValue).toBe(false);
  expect(by("pointsLimit")?.defaultValue).toBe(false);
  expect(by("chat")?.defaultValue).toBe("ONLINE");
  expect(by("strategy")?.defaultValue).toBe("SMART");
  expect(by("delayMode")?.defaultValue).toBe("FROM_END");
  expect(by("minimumPoints")?.defaultValue).toBe(0);
});

test("describes a default in words a person can read", () => {
  const by = (key: string) => SETTINGS_FIELDS.find((f) => f.key === key)!;
  expect(describeDefault(by("watchStreak"))).toBe("On");
  expect(describeDefault(by("communityGoals"))).toBe("Off");
  expect(describeDefault(by("pointsLimit"))).toBe("No limit");
  expect(describeDefault(by("chat"))).toBe("Online");
  // Upstream's StreamerSettings.default() fills an unset value with
  // HLSSettings(watch_all_segments="drops"), so the default is on, not off.
  expect(describeDefault(by("simulateHlsPlayback"))).toBe("Full when earning drops");
  expect(describeDefault(by("claimDrops"))).toBe("Linked accounts");
});

test("offers exactly the modes the backend schema accepts", () => {
  // Mirrors DROPS_MODES and HLS_MODES in apps/backend/src/config/schema.ts.
  const options = (key: string) => {
    const kind = SETTINGS_FIELDS.find((f) => f.key === key)!.kind;
    return kind.kind === "enum" ? new Set(kind.options) : null;
  };
  expect(options("claimDrops")).toEqual(new Set(["NONE", "LINKED", "ALL"]));
  expect(options("simulateHlsPlayback"))
    .toEqual(new Set(["OFF", "DROPS", "ALL_SEGMENTS", "LAST_SEGMENT"]));
});

test("every field has help text, so no control ships unexplained", () => {
  for (const field of [...SETTINGS_FIELDS, ...BET_FIELDS]) {
    expect(field.help.length).toBeGreaterThan(0);
  }
});
