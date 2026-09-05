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
  },
});
