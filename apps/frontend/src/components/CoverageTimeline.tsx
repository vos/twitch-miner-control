import { Group, Stack, Text } from "@mantine/core";
import { coverageRows, type Span } from "../lib/coverageRows.js";
import { formatWorked } from "../lib/formatWorked.js";

/** The band's coordinate space; it renders fluid via preserveAspectRatio. */
const TRACK_WIDTH = 100;
const TRACK_HEIGHT = 10;

/**
 * A day-by-day strip of when this channel was live, and how much of that
 * we were actually mining.
 *
 * The gap between the two tones is the point of the block: a channel that
 * streamed eight hours while the miner was down earned nothing, and no
 * other view in the app says so. Hand-rolled SVG rather than a chart
 * library -- these are interval bands on a fixed 24-hour track, which is
 * a Gantt row, not a plot.
 */
export function CoverageTimeline({ coverage, days }: {
  coverage: { live: Span[]; mined: Span[] };
  days: number;
}) {
  const rows = coverageRows(coverage.live, coverage.mined, days, Date.now());

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center">
        <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
          COVERAGE
        </Text>
        <Text size="xs" c="dimmed">mined / live</Text>
      </Group>

      {rows.map((row) => (
        <Group key={row.dayStart} gap="sm" wrap="nowrap" data-testid="coverage-day">
          <Text size="xs" c="dimmed" style={{ width: 52, flexShrink: 0 }}>
            {new Date(row.dayStart).toLocaleDateString(undefined,
              { month: "short", day: "numeric" })}
          </Text>
          <svg
            width="100%"
            height={TRACK_HEIGHT}
            viewBox={`0 0 ${TRACK_WIDTH} ${TRACK_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
            style={{ display: "block", flex: 1 }}
          >
            <rect
              x={0} y={0} width={TRACK_WIDTH} height={TRACK_HEIGHT}
              fill="var(--tw-border)" fillOpacity={0.35} rx={1}
            />
            {row.live.map((band, i) => (
              <rect
                key={`live-${i}`}
                data-testid="live-band"
                x={band.startFraction * TRACK_WIDTH}
                y={0}
                width={Math.max(0.4, (band.endFraction - band.startFraction) * TRACK_WIDTH)}
                height={TRACK_HEIGHT}
                fill="var(--tw-live)"
                fillOpacity={0.35}
              />
            ))}
            {row.mined.map((band, i) => (
              <rect
                key={`mined-${i}`}
                data-testid="mined-band"
                x={band.startFraction * TRACK_WIDTH}
                y={0}
                width={Math.max(0.4, (band.endFraction - band.startFraction) * TRACK_WIDTH)}
                height={TRACK_HEIGHT}
                fill="var(--tw-success)"
              />
            ))}
          </svg>
          <Text
            size="xs" c="dimmed" data-testid="coverage-total"
            style={{ width: 72, flexShrink: 0, textAlign: "right" }}
          >
            {/* A day the channel never streamed has nothing to report --
                "0m / 0m" reads as a failure to mine rather than as an
                absence of anything to mine. */}
            {row.liveMs === 0
              ? "—"
              : `${formatWorked(row.minedMs)} / ${formatWorked(row.liveMs)}`}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
