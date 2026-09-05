/**
 * A pickaxe striking a channel-points coin.
 *
 * Deliberately not the upstream banner: that art is branded for
 * rdavydov's V2 fork (this repo vendors mpforce1's -- see .gitmodules)
 * and is amber-on-white, which cannot sit on a near-black page without
 * heavy treatment. See the design spec.
 *
 * The geometry is explicit rather than transform-driven: a rotated
 * handle swung outside the viewBox and rendered as two disconnected
 * shapes. Checked by rasterising at both 256px and 28px -- at sidebar
 * size the coin ring and blade still read once the glyph detail drops.
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Miner Control"
    >
      {/* Channel-points coin. */}
      <circle cx="17" cy="32" r="11" fill="var(--tw-warn)" />
      <circle cx="17" cy="32" r="7.6" fill="#0E0E10" fillOpacity="0.13" />
      {/* Twitch glyph on the coin face. */}
      <path
        d="M13.1 29.1h7.8v4.7l-2.6 2.6h-1.9l-1.5 1.5v-1.5h-1.8zm1.5 1.4v4.4h1.3v-4.4zm4.4 0v2.7h1.3v-2.7zm-2.5 0v2.7h1.3v-2.7z"
        fill="#0E0E10"
        fillOpacity="0.82"
      />
      {/* Handle, striking down into the coin. */}
      <path
        d="M36.5 12.5 L24 25"
        stroke="var(--tw-purple-hover)"
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      {/* Blade. */}
      <path
        d="M31.6 8.2c4.3-1.8 9.2-0.7 12.1 2.9-3.2-0.9-6-0.6-8.4 1.1 1.3 2.3 1.7 4.9 1 7.8-3.9-2.3-6-6.7-4.7-11.8z"
        fill="var(--tw-purple)"
      />
    </svg>
  );
}
