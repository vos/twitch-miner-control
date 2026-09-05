import { expect, test } from "vitest";
import { theme } from "./theme.js";

test("uses the Twitch brand purple as the primary color", () => {
  // The exact brand hex must be what actually renders, not an
  // approximation Mantine picked from a generated scale.
  expect(theme.primaryColor).toBe("twitch");
  expect(theme.colors?.twitch?.[6]).toBe("#9147FF");
  expect(theme.primaryShade).toBe(6);
});

test("sets monospace to the tabular-figure face used for every number", () => {
  // Balances, uptime and log lines all render here; a proportional
  // fallback makes a ticking uptime jitter.
  expect(theme.fontFamilyMonospace).toMatch(/JetBrains Mono/);
});
