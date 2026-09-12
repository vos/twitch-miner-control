import { IconUserFilled } from "@tabler/icons-react";
import { formatViewers } from "../lib/formatViewers.js";
import classes from "./StreamContext.module.css";

/**
 * The live audience, as a figure in its own right.
 *
 * Split from StreamContext so it can sit in its own grid cell, right
 * aligned under the status pill: it is a number, and it belongs in a
 * column with the other number above it rather than trailing a line of
 * prose that truncates. Keeping them together also meant a channel with
 * no category set reported no audience either, though the two are
 * independent facts.
 *
 * Renders nothing when the channel is offline -- a stream that is not
 * running has no audience, which is not the same as an audience of zero.
 */
export function ViewerCount({ viewers }: { viewers: number | null }) {
  const audience = formatViewers(viewers);
  if (audience === null) return null;
  return (
    // The glyph is what makes the number mean something: "2.0K" alone is
    // an unlabelled figure, and this is how Twitch itself marks an
    // audience. Labelled for screen readers, which cannot see the icon
    // carrying the noun.
    <span
      className={classes.viewers}
      data-testid="viewers"
      aria-label={`${audience} viewers`}
    >
      <IconUserFilled className={classes.viewerIcon} aria-hidden />
      {audience}
    </span>
  );
}
