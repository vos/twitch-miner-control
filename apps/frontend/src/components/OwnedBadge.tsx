import { Badge, Text, Tooltip } from "@mantine/core";
import classes from "./OwnedBadge.module.css";

/**
 * The badge marking a channel the drops engine added on its own.
 *
 * Shared by the dashboard card and the Streamers row, which both render
 * it and previously each carried their own copy -- the two drifted, and
 * a user who learned what the badge meant on one screen met a different
 * sentence on the other. One component keeps the wording, the truncation
 * and the tooltip identical wherever it appears.
 *
 * The GAME leads rather than the campaign name. Campaign names are
 * mostly unrecognisable on their own -- "DF Streamer Ladder FINNAL" is
 * Delta Force, "Mayhem Collection Launch" is LEGO Batman -- and run long
 * enough to break the row they sit in. The campaign is still what you
 * unsubscribe from, so it leads the tooltip and rides the aria-label.
 */
export function OwnedBadge({
  label,
  game,
  testId,
  /** `xs` on the dense Streamers row, `sm` on a dashboard card. */
  size = "sm",
}: {
  /** The campaign's own label, and what makes the channel owned at all. */
  label: string | null | undefined;
  /** The game it is for, or null when the catalogue no longer knows. */
  game: string | null | undefined;
  testId: string;
  size?: "xs" | "sm";
}) {
  // Read defensively: a snapshot from a backend predating either field
  // arrives undefined, and `!== null` alone would let that through.
  const campaign = label ?? null;
  if (campaign === null || campaign === "") return null;
  const shown = game !== null && game !== undefined && game !== ""
    ? game
    : campaign;

  return (
    <Tooltip
      multiline
      w={230}
      label={
        <>
          <Text size="xs" fw={600}>{campaign}</Text>
          {/* Two lines rather than one joined by a separator: at this
              width "unsubscribe on Drops" wrapped mid-phrase, which read
              as a layout fault. Breaking it deliberately puts the wrap
              where the sense already breaks. */}
          <Text size="xs" c="dimmed">Auto-added for drops</Text>
          <Text size="xs" c="dimmed">Unsubscribe on Drops</Text>
        </>
      }
    >
      {/* Light rather than outline: an outline badge on the card's dark
          background is a thin ring around transparent fill and all but
          disappears. The filled tint matches every other badge beside it.

          Truncated, unlike those neighbours: they are short by nature
          ("claim", "×2") where this carries a name running to 38
          characters, which used to push the row past the card's edge.
          Clipping is acceptable here only because the whole text stays
          on the tooltip and the aria-label. */}
      <Badge
        color="grape"
        variant="light"
        size={size}
        data-testid={testId}
        className={classes.owned}
        aria-label={`Added automatically to collect drops from ${campaign}`}
      >
        {shown}
      </Badge>
    </Tooltip>
  );
}
