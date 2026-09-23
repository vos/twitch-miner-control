import { Divider, Group, Stack, Text, Tooltip } from "@mantine/core";
import { useState, type MouseEvent } from "react";
import type { PointSample } from "../lib/bucketPoints.js";
import {
  collapseQuietDays, coverageRows, dayStretches, pointsBetween, stateAt,
  type CoverageDay, type Span,
} from "../lib/coverageRows.js";
import { formatClock } from "../lib/formatClock.js";
import { formatWorked, formatWorkedMinutes } from "../lib/formatWorked.js";
import { LOW_COVERAGE } from "./StreamHistoryTable.js";
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

const nf = new Intl.NumberFormat("en-US");
const weekday = new Intl.DateTimeFormat(undefined,
  { weekday: "short", month: "short", day: "numeric" });

/** A band's end on the card. A stretch cut at midnight ends at "24:00":
 *  the clock would print "00:00", which reads as the start of the day. */
function endLabel(end: number, dayEnd: number): string {
  return end === dayEnd ? "24:00" : formatClock(end);
}

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
export function CoverageTimeline({ coverage, days, series = [] }: {
  coverage: { live: Span[]; mined: Span[] };
  days: number;
  /** Balance samples, for the points a day earned on its hover card. */
  series?: PointSample[];
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
        <DayRow key={entry.day.dayStart} day={entry.day} series={series} />
      ))}
    </Stack>
  );
}

/**
 * One day of the strip. Hovering its track opens a card that follows the
 * pointer, with a hairline marking the time under it -- the band alone
 * says a stream happened in the afternoon, not that it ran 14:02-18:40.
 */
function DayRow({ day, series }: { day: CoverageDay; series: PointSample[] }) {
  const [cursor, setCursor] = useState<number | null>(null);

  const track = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    setCursor(Math.min(1, Math.max(0, fraction)));
  };

  return (
    <Group gap="sm" wrap="nowrap" data-testid="coverage-day">
      <Text size="xs" c="dimmed" style={{ width: 52, flexShrink: 0 }}>
        {new Date(day.dayStart).toLocaleDateString(undefined,
          { month: "short", day: "numeric" })}
      </Text>
      <Tooltip.Floating
        position="top"
        offset={14}
        label={<DayCard day={day} series={series} cursor={cursor} />}
      >
        <div
          className={classes.track}
          data-testid="coverage-track"
          onMouseMove={track}
          onMouseLeave={() => setCursor(null)}
        >
          <svg
            width="100%"
            height={TRACK_HEIGHT}
            viewBox={`0 0 ${TRACK_WIDTH} ${TRACK_HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
            style={{ display: "block" }}
          >
            <rect
              x={0} y={0} width={TRACK_WIDTH} height={TRACK_HEIGHT}
              fill="var(--tw-border)" fillOpacity={0.35} rx={1}
            />
            {day.live.map((band, i) => (
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
            {day.mined.map((band, i) => (
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
            {cursor !== null && (
              <line
                data-testid="coverage-cursor"
                x1={cursor * TRACK_WIDTH} x2={cursor * TRACK_WIDTH}
                y1={0} y2={TRACK_HEIGHT}
                stroke="var(--tw-text)"
                strokeWidth={1}
                // The viewBox is stretched to the row's width; without
                // this the hairline would be stretched with it.
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        </div>
      </Tooltip.Floating>
      <Text
        size="xs" c="dimmed" data-testid="coverage-total"
        style={{ width: 72, flexShrink: 0, textAlign: "right" }}
      >
        {/* A day the channel never streamed has nothing to report --
            "0m / 0m" reads as a failure to mine rather than as an
            absence of anything to mine. */}
        {day.liveMs === 0
          ? "—"
          : `${formatWorked(day.minedMs)} / ${formatWorked(day.liveMs)}`}
      </Text>
    </Group>
  );
}

function Swatch({ color, opacity }: { color: string; opacity: number }) {
  return (
    <span
      className={classes.swatch}
      style={{ background: color, opacity }}
    />
  );
}

/** The hover card: the moment under the pointer, then the day in full. */
function DayCard({ day, series, cursor }: {
  day: CoverageDay;
  series: PointSample[];
  cursor: number | null;
}) {
  const stretches = dayStretches(day);
  const at = cursor === null ? null : day.dayStart + cursor * (day.dayEnd - day.dayStart);
  const state = at === null ? null : stateAt(day, at);
  const coverage = day.liveMs === 0 ? null : Math.min(1, day.minedMs / day.liveMs);
  const points = pointsBetween(series, day.dayStart, Math.min(day.dayEnd, Date.now()));

  return (
    <Stack gap={6} w={260} data-testid="coverage-card">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={700}>{weekday.format(day.dayStart)}</Text>
        {at !== null && state !== null && (
          <Group gap={6} wrap="nowrap" data-testid="coverage-card-now">
            <Text size="xs" ff="monospace">{formatClock(at)}</Text>
            <Text size="xs" c="dimmed">
              {!state.live ? "offline" : state.mined ? "live · mining" : "live · missed"}
            </Text>
          </Group>
        )}
      </Group>

      <Stack gap={2}>
        {stretches.map((st) => {
          const under = at !== null && at >= st.start && at < st.end;
          return (
            <Group
              key={st.start} justify="space-between" wrap="nowrap"
              data-testid="coverage-card-stretch"
              className={under ? classes.stretchActive : classes.stretch}
            >
              <Group gap={6} wrap="nowrap">
                <Swatch color="var(--tw-live)" opacity={0.8} />
                <Text size="xs" ff="monospace">
                  {formatClock(st.start)}–{endLabel(st.end, day.dayEnd)}
                </Text>
              </Group>
              <Group gap={6} wrap="nowrap">
                <Text size="xs" c="dimmed">{formatWorkedMinutes(st.end - st.start)}</Text>
                <Swatch color="var(--tw-success)" opacity={MINED_OPACITY} />
                <Text size="xs">{formatWorkedMinutes(st.minedMs)}</Text>
              </Group>
            </Group>
          );
        })}
      </Stack>

      <Divider color="var(--tw-border)" />

      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          Mined {formatWorkedMinutes(day.minedMs)} of {formatWorkedMinutes(day.liveMs)}
        </Text>
        {coverage !== null && (
          <Text
            size="xs" fw={700} data-testid="coverage-card-percent"
            c={coverage < LOW_COVERAGE ? "var(--tw-warn)" : "var(--tw-success)"}
          >
            {Math.round(coverage * 100)}%
          </Text>
        )}
      </Group>
      {points !== null && points !== 0 && (
        <Group justify="space-between" wrap="nowrap" data-testid="coverage-card-points">
          <Text size="xs" c="dimmed">Points</Text>
          <Text size="xs" fw={700} c={points > 0 ? "var(--tw-success)" : "var(--tw-live)"}>
            {points > 0 ? "+" : ""}{nf.format(points)}
          </Text>
        </Group>
      )}
    </Stack>
  );
}
