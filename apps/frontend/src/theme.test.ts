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

test("tooltips use the dark overlay, not Mantine's light default", () => {
  // The app is forced dark. Mantine's stock tooltip is near-white, which
  // glares against every surface it is summoned over -- and it is the
  // only floating surface that did not follow the palette.
  const props = theme.components?.Tooltip?.defaultProps as
    { bg?: string; color?: string } | undefined;
  expect(props?.bg).toBe("var(--tw-overlay)");
  expect(props?.color).toBe("var(--tw-text)");
});

test("a tooltip is separated from the surface it opens over", () => {
  // --tw-overlay alone is not enough on the darkest backgrounds: the
  // panel needs an edge, or it reads as text bleeding onto the card
  // rather than a panel floating above it. This is the whole reason the
  // tooltip stopped sharing --tw-surface-alt with inset elements.
  const styles = theme.components?.Tooltip?.styles as
    { tooltip?: { border?: string; boxShadow?: string } } | undefined;
  expect(styles?.tooltip?.border).toMatch(/var\(--tw-border\)/);
  expect(styles?.tooltip?.boxShadow).toBeTruthy();
});

test("floating tooltips match the regular ones", () => {
  // Mantine themes Tooltip.Floating under its own name, so without its
  // own entry it falls back to the stock near-white panel.
  const props = theme.components?.TooltipFloating?.defaultProps as
    { bg?: string } | undefined;
  expect(props?.bg).toBe("var(--tw-overlay)");
});
