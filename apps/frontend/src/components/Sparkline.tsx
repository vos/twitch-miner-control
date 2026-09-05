interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  fill?: boolean;
}

/**
 * A bare trend line: no axes, no ticks, no interaction.
 *
 * Deliberately not a chart. It answers "is this climbing or flat?" at a
 * glance, next to the exact numbers that answer "by how much". Hidden from
 * assistive tech because it carries no information the adjacent gain
 * figures do not already state precisely.
 */
export function Sparkline({ values, width = 88, height = 24, fill = false }: SparklineProps) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series has zero range; dividing by it would yield NaN
  // coordinates and drop the line entirely. Pin it to the midline instead.
  const range = max - min || 1;
  const stepX = width / (values.length - 1);

  const points = values
    .map((value, i) => {
      const x = i * stepX;
      const y = max === min ? height / 2 : height - ((value - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  // Closing the path down to the baseline gives the card a soft area
  // fill; the line alone reads thin across a full-width card.
  const area = `0,${height} ${points} ${width},${height}`;

  return (
    <svg width={width} height={height} aria-hidden="true" focusable="false">
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
      />
    </svg>
  );
}
