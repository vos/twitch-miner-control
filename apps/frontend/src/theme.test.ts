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

test("tooltips use the dark surface, not Mantine's light default", () => {
  // The app is forced dark. Mantine's stock tooltip is near-white, which
  // glares against every surface it is summoned over -- and it is the
  // only floating surface that did not follow the palette.
  const props = theme.components?.Tooltip?.defaultProps as
    { bg?: string; color?: string } | undefined;
  expect(props?.bg).toBe("var(--tw-surface-alt)");
  expect(props?.color).toBe("var(--tw-text)");
});
