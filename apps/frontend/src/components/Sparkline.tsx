interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  fill?: boolean;
  /**
   * Marks the rendered SVG. Optional so callers that do not need to
   * assert on the line -- most of them -- stay unchanged; the attribute
   * lands on the svg itself rather than a wrapper, so its presence
   * tracks whether a line was actually drawn.
   */
  "data-testid"?: string;
}

/** Half the stroke width, so a line on the boundary is not clipped. */
const INSET = 1;

/**
 * A bare trend line: no axes, no ticks, no interaction.
 *
 * Deliberately not a chart. It answers "is this climbing or flat?" at a
 * glance, next to the exact numbers that answer "by how much". Hidden from
 * assistive tech because it carries no information the adjacent gain
 * figures do not already state precisely.
 *
 * Renders fluid: `width` and `height` describe the viewBox's coordinate
 * space, while the element itself fills its container. A fixed pixel
 * width painted past the edge of any card narrower than that value.
 */
export function Sparkline(
  { values, width = 88, height = 24, fill = false, ...rest }: SparklineProps,
) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series has zero range; dividing by it would yield NaN
  // coordinates and drop the line entirely. Pin it to the midline instead.
  const range = max - min || 1;

  // Plot inside an inset box: a point at exactly x=0 or y=height would
  // put half the stroke outside the viewBox, which reads on screen as
  // the chart drawing over the card's edge.
  const left = INSET;
  const top = INSET;
  const plotW = width - INSET * 2;
  const plotH = height - INSET * 2;
  const stepX = plotW / (values.length - 1);

  const points = values
    .map((value, i) => {
      const x = left + i * stepX;
      const y = max === min
        ? height / 2
        : top + plotH - ((value - min) / range) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Closing the path down to the baseline gives the card a soft area
  // fill; the line alone reads thin across a full-width card.
  const base = height - INSET;
  const area = `${left},${base} ${points} ${left + plotW},${base}`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
      {...rest}
    >
      {fill && (
        <polygon points={area} fill="var(--tw-success)" fillOpacity="0.12" />
      )}
      <polyline
        points={points}
        fill="none"
        stroke="var(--tw-success)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
