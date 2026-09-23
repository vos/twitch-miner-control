import { createTheme, type MantineColorsTuple } from "@mantine/core";

/**
 * Twitch's brand purple as a full 10-step scale, so `color="twitch"` and
 * `variant="filled"` resolve correctly. Index 6 is the exact brand hex
 * (#9147FF) and `primaryShade` pins rendering to it -- without that pin
 * Mantine picks a shade per color scheme and the brand color is never
 * quite what ships.
 */
const twitch: MantineColorsTuple = [
  "#F3EDFF", "#E0D2FF", "#C7ABFF", "#AC80FF", "#9A5FFF",
  "#9558FF", "#9147FF", "#772CE8", "#6A24D1", "#5C1CBA",
];

export const theme = createTheme({
  primaryColor: "twitch",
  primaryShade: 6,
  colors: { twitch },
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  fontFamilyMonospace: "JetBrains Mono, ui-monospace, SFMono-Regular, monospace",
  defaultRadius: "md",
  headings: {
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    fontWeight: "700",
  },
  components: {
    Card: { defaultProps: { bg: "var(--tw-surface)", withBorder: true } },
    Paper: { defaultProps: { bg: "var(--tw-surface)" } },
    /**
     * Mantine's stock tooltip is near-white, which glares against a
     * forced-dark app -- it was the one floating surface not following
     * the palette. Set here rather than per call site so every tooltip
     * in the app matches, including the ones already written.
     *
     * --tw-overlay rather than --tw-surface-alt: the latter sits 7/255
     * above a card, so a tooltip opening over one had no visible edge
     * and its text read as bleeding onto the card rather than floating
     * above it. The border and shadow finish the separation -- on the
     * darkest backgrounds the fill alone still needs an outline to read
     * as a panel.
     */
    Tooltip: {
      defaultProps: {
        bg: "var(--tw-overlay)",
        color: "var(--tw-text)",
      },
      styles: {
        tooltip: {
          border: "1px solid var(--tw-border)",
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.55)",
        },
      },
    },
    /** Tooltip.Floating is themed under its own name, not Tooltip's. */
    TooltipFloating: {
      defaultProps: {
        bg: "var(--tw-overlay)",
        c: "var(--tw-text)",
      },
      styles: {
        tooltip: {
          border: "1px solid var(--tw-border)",
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.55)",
        },
      },
    },
  },
});
