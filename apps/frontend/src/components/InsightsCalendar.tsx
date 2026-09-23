import { Heatmap } from "@mantine/charts";
import { Group, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import type { ComponentProps } from "react";
import type { CalendarPayload } from "../api/useInsights.js";
import { HEAT_EMPTY, HEAT_STEPS } from "../lib/heatRamp.js";
import { describeDay, quantileSteps, stepColor } from "../lib/insightsFormat.js";

/** One legend square, filled like a calendar cell. */
function Swatch({ fill }: { fill: string }) {
  return (
    <svg width={10} height={10} aria-hidden>
      <rect width={10} height={10} rx={2} fill={fill} />
    </svg>
  );
}

/**
 * A year of points earned, one cell per day, Monday-first.
 *
 * Colours come from the shared ramp at quartiles of the user's own days,
 * set per cell through getRectProps: Heatmap's own `colors` scale is
 * linear across the domain. Days before tracking began are hatched, not
 * empty, so the calendar never claims zero for days it has no record of.
 */
export function InsightsCalendar({ calendar, onPickDay }: {
  calendar: CalendarPayload;
  onPickDay: (date: string) => void;
}) {
  // Below the sidebar breakpoint half a year fits the width; a full one
  // would need a scroller.
  const narrow = useMediaQuery("(max-width: 48em)", false, { getInitialValueInEffect: false });
  const shown = calendar.days.slice(narrow ? -26 * 7 : 0);
  const byDate = new Map(shown.map((d) => [d.date, d]));
  const thresholds = quantileSteps(shown.map((d) => d.earned));
  const since = calendar.since;

  return (
    <>
      {/* The hatch for no-data days. A url(#id) resolves across inline
          SVGs in one document, so the pattern lives here, not inside the
          Heatmap, which renders its own <svg>. */}
      <svg width={0} height={0} aria-hidden style={{ position: "absolute" }}>
        <defs>
          <pattern
            id="insights-hatch" width={4} height={4}
            patternUnits="userSpaceOnUse" patternTransform="rotate(45)"
          >
            <rect width={4} height={4} fill="var(--tw-surface)" />
            <line x1={0} y1={0} x2={0} y2={4} stroke="var(--tw-border)" strokeWidth={2} />
          </pattern>
        </defs>
      </svg>
      <Heatmap
        data={Object.fromEntries(shown.map((d) => [d.date, d.earned]))}
        startDate={shown[0]?.date}
        endDate={shown[shown.length - 1]?.date}
        firstDayOfWeek={1}
        withOutsideDates={false}
        withMonthLabels
        withWeekdayLabels
        rectSize={12}
        gap={2}
        colors={[...HEAT_STEPS]}
        withTooltip
        getTooltipLabel={({ date }) => {
          const day = byDate.get(date);
          return day === undefined ? date : describeDay(day, since);
        }}
        getRectProps={({ date, value }) => ({
          fill: since === null || date < since
            ? "url(#insights-hatch)"
            : stepColor(value ?? 0, thresholds),
          onClick: () => onPickDay(date),
          style: { cursor: "pointer" },
          "data-date": date,
        } as ComponentProps<"rect">)}
      />
      {/* Our own legend: Heatmap's withLegend would draw its linear
          scale, not the quartile steps the cells actually use. */}
      <Group gap={4} wrap="nowrap" data-testid="calendar-legend">
        <Text size="xs" c="dimmed">less</Text>
        {[HEAT_EMPTY, ...HEAT_STEPS].map((fill) => <Swatch key={fill} fill={fill} />)}
        <Text size="xs" c="dimmed" mr="md">more</Text>
        <Swatch fill="url(#insights-hatch)" />
        <Text size="xs" c="dimmed">before tracking began</Text>
      </Group>
    </>
  );
}
