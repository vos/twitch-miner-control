import { Group, Stack, Text } from "@mantine/core";
import { collapseQuietDays, coverageRows, type Span } from "../lib/coverageRows.js";
import { formatWorked } from "../lib/formatWorked.js";
import classes from "./CoverageTimeline.module.css";

/** The band's coordinate space; it renders fluid via preserveAspectRatio. */
const TRACK_WIDTH = 100;
const TRACK_HEIGHT = 10;

/**
 * Short of full strength.
 *
 * --tw-success is a saturated neon green, sized for a sparkline stroke or
 * a few characters of gain text. Here it fills whole rows at once, and a
 * miner up for days turned the strip into a solid block of it.
 *
 * Dimmed, the band still reads as the emphatic half of the pair against
 * the 0.35 live tone beneath it -- which is the comparison this block
 * exists to make -- without glowing. Opacity rather than a second green
 * token, so --tw-success stays the one success colour the app has.
 */
const MINED_OPACITY = 0.75;

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
  const entries = collapseQuietDays(
    coverageRows(coverage.live, coverage.mined, days, Date.now()),
  );

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center">
        <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
          COVERAGE
        </Text>
        <Text size="xs" c="dimmed">mined / live</Text>
      </Group>

      {entries.length === 0 && (
        <Text size="xs" c="dimmed" data-testid="coverage-empty">
          This channel has not streamed in this window.
        </Text>
      )}

      {entries.map((entry) => entry.kind === "gap" ? (
        <Group key={entry.from} gap="sm" wrap="nowrap" data-testid="coverage-gap">
          <div className={classes.gapRule} />
          <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
            {entry.days} days dark
          </Text>
          <div className={classes.gapRule} />
        </Group>
      ) : (
        <Group key={entry.day.dayStart} gap="sm" wrap="nowrap" data-testid="coverage-day">
          <Text size="xs" c="dimmed" style={{ width: 52, flexShrink: 0 }}>
            {new Date(entry.day.dayStart).toLocaleDateString(undefined,
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
            {entry.day.live.map((band, i) => (
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
            {entry.day.mined.map((band, i) => (
              <rect
                key={`mined-${i}`}
                data-testid="mined-band"
                x={band.startFraction * TRACK_WIDTH}
                y={0}
                width={Math.max(0.4, (band.endFraction - band.startFraction) * TRACK_WIDTH)}
                height={TRACK_HEIGHT}
                fill="var(--tw-success)"
                fillOpacity={MINED_OPACITY}
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
            {entry.day.liveMs === 0
              ? "—"
              : `${formatWorked(entry.day.minedMs)} / ${formatWorked(entry.day.liveMs)}`}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
