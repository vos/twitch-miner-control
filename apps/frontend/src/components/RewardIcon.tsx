import { Image } from "@mantine/core";
import { IconGift } from "@tabler/icons-react";
import classes from "./RewardIcon.module.css";

/**
 * One drop reward's artwork.
 *
 * Falls back to a gift glyph rather than a broken image: the source
 * omits `imageAssetUrl` on some benefits, and a catalogue persisted
 * before the field was parsed has none at all. Mantine's Image swaps to
 * `fallbackSrc` only for a failed load, so the null case is handled here
 * instead -- an <img> with no src still renders the browser's own
 * "missing image" chrome.
 *
 * Decorative by default: the reward name is rendered beside it in the
 * gallery, and a screen reader announcing both says everything twice.
 * The collapsed row on a card has no such label, so it passes its own
 * alt text through.
 */
export function RewardIcon({ name, imageUrl, size = 28, alt = "" }: {
  name: string;
  imageUrl: string | null;
  size?: number;
  /** Left empty when a visible label already names the reward. */
  alt?: string;
}) {
  if (imageUrl === null) {
    return (
      <div
        className={classes.placeholder}
        style={{ width: size, height: size }}
        role={alt === "" ? undefined : "img"}
        aria-label={alt === "" ? undefined : alt}
        aria-hidden={alt === "" ? true : undefined}
        data-testid="reward-placeholder"
        title={name}
      >
        <IconGift size={Math.round(size * 0.6)} />
      </div>
    );
  }
  return (
    <Image
      src={imageUrl}
      alt={alt}
      w={size}
      h={size}
      radius="sm"
      className={classes.icon}
      // The reward name on hover: the gallery labels every tile, but the
      // collapsed icon row has room for pictures only.
      title={name}
      data-testid="reward-icon"
    />
  );
}
