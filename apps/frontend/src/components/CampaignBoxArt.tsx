import { Image } from "@mantine/core";
import classes from "./CampaignBoxArt.module.css";

/** The aspect the Twitch box art CDN serves, and what the tile reserves. */
export const BOX_ART_RATIO = 3 / 4;

/**
 * Asks the CDN for the size actually rendered.
 *
 * Twitch box art URLs carry their dimensions in the filename
 * (`..._IGDB-285x380.jpg`), so the default costs ~14KB per card where
 * the tile only ever draws ~90px wide. With a hundred campaigns on the
 * page that is megabytes of pixels thrown away on resize.
 *
 * Requests 2x the CSS size so the tile stays sharp on a retina display.
 * A URL not matching the pattern is returned untouched rather than
 * rewritten on a guess -- an invented filename 404s, and the fallback
 * below would then replace real art with a monogram.
 */
export function sized(url: string, width: number): string {
  const height = Math.round(width / BOX_ART_RATIO);
  return url.replace(
    /-\d+x\d+(\.[a-z]+)$/i,
    (_whole, ext: string) => `-${width * 2}x${height * 2}${ext}`,
  );
}

/**
 * A campaign's game box art, or its initial when there is none.
 *
 * The fallback is a letter tile rather than a blank space: the grid's
 * rhythm depends on every card having an image column, and a missing one
 * leaves a hole that reads as a layout fault. `unoptimized` names are
 * fine here -- the letter is derived from the game name, which is always
 * present when a game is.
 *
 * The image itself is decorative -- the game name is the card's title,
 * rendered immediately beside it, so alt text would have a screen reader
 * announce the same game twice. With a slug the wrapping link carries
 * the accessible name instead, because a link with no name is one a
 * screen reader cannot describe.
 */
export function CampaignBoxArt({ url, displayName, slug, width = 88 }: {
  url: string | null | undefined;
  displayName: string;
  /**
   * The game's Twitch category slug, which turns the art into a link.
   *
   * Absent or empty means no link rather than a guessed one: a slug
   * invented from a display name lands on a 404.
   */
  slug?: string | null;
  width?: number;
}) {
  const height = Math.round(width / BOX_ART_RATIO);

  const art = url === null || url === undefined || url === "" ? (
      <div
        className={classes.fallback}
        style={{ width, height }}
        data-testid="box-art-fallback"
        // Only decorative when it is not the link: as a link it needs
        // an accessible name, which the wrapper below supplies.
        aria-hidden={slug === undefined || slug === null || slug === ""}
      >
        {displayName.charAt(0).toUpperCase()}
      </div>
  ) : (
    <Image
      src={sized(url, width)}
      alt=""
      w={width}
      h={height}
      radius="sm"
      className={classes.art}
      data-testid="box-art"
      // A dead CDN URL degrades to the same letter tile the null case
      // draws, so a 404 never leaves a broken-image glyph on the card.
      fallbackSrc={`data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
        + `<rect width="100%" height="100%" fill="#1F1F23"/>`
        + `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" `
        + `font-family="sans-serif" font-size="${Math.round(width / 2)}" `
        + `fill="#ADADB8">${displayName.charAt(0).toUpperCase()}</text></svg>`,
      )}`}
    />
  );

  if (slug === undefined || slug === null || slug === "") return art;

  return (
    // A new tab: this page is a control panel with a live session behind
    // it, and navigating it away to glance at a category loses that.
    // Matches the channel links in the subscriptions panel.
    <a
      // ?filter=drops narrows the directory to channels actually running
      // drops for this game, which is the point of arriving here from a
      // drops page. It is the same URL Twitch's own campaign list uses
      // for "go to a participating live channel".
      href={`https://twitch.tv/directory/category/${slug}?filter=drops`}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={`${displayName} on Twitch`}
      className={classes.link}
      style={{ width, height }}
    >
      {art}
    </a>
  );
}
