import { Group, Stack, Text, Tooltip } from "@mantine/core";
import { Fragment } from "react";
import type { ScheduleResponse } from "../api/useLiveSchedule.js";
import { HEAT_EMPTY, HEAT_STEPS, heatColor } from "../lib/heatRamp.js";
import { bucketSchedule, hourOfWeek } from "../lib/liveSchedule.js";
import classes from "./LiveSchedule.module.css";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAYS_PLURAL = [
  "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays",
];
/** Hour labels under the grid; every hour would crowd a 24-column row. */
const HOUR_TICKS = new Set([0, 6, 12, 18]);
/** The grid's own window; the heading reports less when tracking is newer. */
const MAX_WEEKS = 12;
/** Below this the grid is mostly guesswork, so it is not drawn. */
const MIN_WEEKS = 2;

const pad = (hour: number) => `${String(hour % 24).padStart(2, "0")}:00`;

/** "Tuesdays 20:00–21:00 · live 9 of 12 weeks". */
function describe(index: number, live: number, of: number): string {
  const day = Math.floor(index / 24);
  const hour = index % 24;
  return `${DAYS_PLURAL[day]} ${pad(hour)}–${pad(hour + 1)} · live ${live} of ${of} week${of === 1 ? "" : "s"}`;
}

/**
 * When a channel is usually live: hours of the week, shaded by how many of
 * the observed weeks it was live in that hour.
 *
 * It carries its own window in its heading because the dialog's range
 * control above does not govern it.
 */
export function LiveSchedule({ data, error }: {
  data: ScheduleResponse | null;
  error: string | null;
}) {
  const schedule = data === null ? null : bucketSchedule(data.spans, data.since, data.now);
  const drawn = error === null && schedule !== null && schedule.weeks >= MIN_WEEKS;
  // The window actually covered, which is less than twelve weeks for a
  // channel tracked for less. Named only once there is a grid to name it for.
  const heading = drawn
    ? `USUALLY LIVE · LAST ${Math.min(MAX_WEEKS, Math.floor(schedule!.weeks))} WEEKS`
    : "USUALLY LIVE";
  const current = hourOfWeek(new Date());

  let body;
  if (error !== null) {
    body = <Text size="xs" c="dimmed" data-testid="schedule-error">Schedule unavailable.</Text>;
  } else if (schedule === null) {
    body = <Text size="xs" c="dimmed" data-testid="schedule-loading">Loading schedule…</Text>;
  } else if (schedule.weeks < MIN_WEEKS) {
    body = (
      <Text size="xs" c="dimmed" data-testid="schedule-too-new">
        Needs a couple of weeks of tracking.
      </Text>
    );
  } else {
    body = (
      <div className={classes.grid} role="group" aria-label="Live by weekday and hour">
        {DAYS.map((day, d) => (
          <Fragment key={day}>
            <Text size="xs" c="dimmed">{day}</Text>
            {Array.from({ length: 24 }, (_, h) => {
              const index = d * 24 + h;
              const { live, of } = schedule.cells[index];
              const label = describe(index, live, of);
              const now = index === current;
              return (
                <Tooltip key={h} label={label} openDelay={0}>
                  <div
                    role="img"
                    aria-label={label}
                    className={now ? `${classes.cell} ${classes.now}` : classes.cell}
                    style={{ backgroundColor: of === 0 ? HEAT_EMPTY : heatColor(live / of) }}
                    data-testid="schedule-cell"
                    data-hour={index}
                    data-now={now ? "true" : undefined}
                  />
                </Tooltip>
              );
            })}
          </Fragment>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <Text key={h} size="xs" c="dimmed" style={{ fontSize: 10 }}>
            {HOUR_TICKS.has(h) ? h : ""}
          </Text>
        ))}
      </div>
    );
  }

  return (
    <Stack gap="xs" data-testid="live-schedule">
      <Group justify="space-between" align="center">
        <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
          {heading}
        </Text>
        <Group gap={4} wrap="nowrap" aria-hidden>
          <Text size="xs" c="dimmed">never</Text>
          {[HEAT_EMPTY, ...HEAT_STEPS].map((colour) => (
            <span key={colour} className={classes.legendSwatch} style={{ backgroundColor: colour }} />
          ))}
          <Text size="xs" c="dimmed">every week</Text>
        </Group>
      </Group>
      {body}
    </Stack>
  );
}
