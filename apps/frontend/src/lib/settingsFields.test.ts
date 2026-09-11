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
  // HLSSettings(refresh_before=2 * 60), so the default is 120s on, not off.
  expect(describeDefault(by("simulateHlsPlayback"))).toBe("120");
});

test("every field has help text, so no control ships unexplained", () => {
  for (const field of [...SETTINGS_FIELDS, ...BET_FIELDS]) {
    expect(field.help.length).toBeGreaterThan(0);
  }
});
