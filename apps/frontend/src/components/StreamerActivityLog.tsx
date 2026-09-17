import { Group, ScrollArea, Stack, Text } from "@mantine/core";
import { collapseActivity } from "../lib/collapseActivity.js";
import { formatClock } from "../lib/formatClock.js";
import classes from "./StreamerActivityLog.module.css";

const nf = new Intl.NumberFormat("en-US");

export interface ActivityEvent {
  ts: number;
  type: string;
  message: string | null;
}

const dayKey = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/**
 * This channel's own event history.
 *
 * Every line goes through parseActivity (via collapseActivity), the same
 * reader the card's LAST line uses, so the wording matches between the
 * two. It is also the only safe reader: the balance inside a miner log
 * line went through millify() and reads "12.3k", while the *earned*
 * figure beside it is an exact integer from PubSub. Only those exact
 * figures are ever summed -- see collapseActivity.

 * Consecutive repeats of one event fold into a single row with a count,
 * because a channel flapping offline writes one event per poll and a
 * quiet night otherwise arrives as fifteen identical lines.
 */
export function StreamerActivityLog({ events, maxHeight = 260, fill = false }: {
  events: ActivityEvent[];
  /**
   * Cap on the scrolling region.
   *
   * The default suits the feed as one block among several, where it must
   * not crowd out the blocks below it. The detail dialog's standalone
   * Activity view passes a viewport-relative height instead: there is
   * nothing below it to crowd, and a 260px window inside a tall dialog
   * left the feed scrolling in a letterbox with empty space beneath.
   */
  maxHeight?: number | string;
  /**
   * Stretch to the height the parent gives, instead of sitting at the
   * feed's natural size.
   *
   * The detail dialog's standalone Activity view sets this: its body is
   * a flex column capped at the modal's max-height, so the feed must be
   * the child that grows -- and must be allowed to shrink below its
   * content (min-height:0), or it overflows the modal and earns a second
   * scrollbar beside its own.
   */
  fill?: boolean;
}) {
  if (events.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="activity-empty">
        No activity recorded for this channel yet.
      </Text>
    );
  }

  const days: { key: string; events: ActivityEvent[] }[] = [];
  for (const event of events) {
    const key = dayKey(event.ts);
    const last = days[days.length - 1];
    if (last !== undefined && last.key === key) last.events.push(event);
    else days.push({ key, events: [event] });
  }

  return (
    <Stack gap="xs" style={fill ? { flex: 1, minHeight: 0 } : undefined}>
      <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
        ACTIVITY
      </Text>
      {/* offsetScrollbars, because the overlay scrollbar sat on top of
          the timestamps in the right-hand column -- readable until the
          feed got tall enough to actually scroll, which the dialog's
          standalone Activity view made the normal case. Mantine reserves
          the gutter only while a scrollbar is really there
          (:not([data-vertical-hidden])), so a feed short enough not to
          scroll keeps the full width and gains no stray gap. */}
      <ScrollArea.Autosize
        mah={maxHeight}
        type="auto"
        offsetScrollbars="y"
        style={fill ? { flex: 1, minHeight: 0 } : undefined}
      >
        <Stack gap="sm">
          {days.map((day) => (
            <Stack key={day.key} gap={4}>
              <Text size="xs" c="dimmed" data-testid="activity-day">{day.key}</Text>
              {/* Collapsed per day, so a run never spans the heading
                  above it. */}
              {collapseActivity(day.events).map((row, index) => (
                <Group
                  key={`${row.ts}-${index}`}
                  gap="xs"
                  wrap="nowrap"
                  data-testid="activity-entry"
                >
                  {row.earned !== null && (
                    <Text size="xs" c="teal" fw={600}>+{nf.format(row.earned)}</Text>
                  )}
                  <Text size="xs" truncate>{row.label}</Text>
                  {/* The multiplier, set apart so it cannot be read as
                      part of the label -- "streamer offline x15" as
                      running text looks like an event called that. */}
                  {row.count > 1 && (
                    <span className={classes.count} data-testid="activity-count">
                      ×{row.count}
                    </span>
                  )}
                  <div style={{ flex: 1 }} />
                  <Text size="xs" c="dimmed">{formatClock(row.ts)}</Text>
                </Group>
              ))}
            </Stack>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}
