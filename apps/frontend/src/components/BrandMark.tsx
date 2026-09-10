import logoUrl from "../assets/miner-logo.png";

/**
 * A pickaxe striking a hoard of channel-points coins.
 *
 * Raster rather than the vector glyph this used to draw: the art is
 * detailed enough (bevelled coins, gem shards, a gradient blade) that
 * hand-written paths could not carry it. The source file is 512px,
 * down from the 1254px original -- enough for a 1x render at the
 * largest use (250px, on the password gate) with little to spare on a
 * 2x display, which wants 500.
 *
 * That detail sets a floor on the size: rasterised down, the pickaxe
 * stops reading as separate from the coins somewhere under ~40px, which
 * is why the sidebar asks for 40 and not the 28 the old glyph used.
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      role="img"
      alt="Twitch Miner Control"
      // The art is square with transparent margins; without an explicit
      // box a flex parent is free to stretch it.
      style={{ width: size, height: size, objectFit: "contain" }}
    />
  );
}
