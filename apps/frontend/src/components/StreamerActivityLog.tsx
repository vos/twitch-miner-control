import { Group, ScrollArea, Stack, Text } from "@mantine/core";
import { parseActivity } from "../lib/parseActivity.js";

const nf = new Intl.NumberFormat("en-US");

export interface ActivityEvent {
  ts: number;
  type: string;
  message: string | null;
}

const time = (ts: number) =>
  new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const dayKey = (ts: number) =>
  new Date(ts).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/**
 * This channel's own event history.
 *
 * Every line goes through parseActivity, the same reader the card's LAST
 * line uses, so the wording matches between the two. It is also the only
 * safe reader: the balance inside a miner log line went through millify()
 * and reads "12.3k", while the *earned* figure beside it is an exact
 * integer from PubSub. Nothing here sums anything.
 */
export function StreamerActivityLog({ events }: { events: ActivityEvent[] }) {
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
    <Stack gap="xs">
      <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
        ACTIVITY
      </Text>
      <ScrollArea.Autosize mah={260} type="auto">
        <Stack gap="sm">
          {days.map((day) => (
            <Stack key={day.key} gap={4}>
              <Text size="xs" c="dimmed" data-testid="activity-day">{day.key}</Text>
              {day.events.map((event, index) => {
                const { earned, label } = parseActivity(event.type, event.message);
                return (
                  <Group
                    key={`${event.ts}-${index}`}
                    gap="xs"
                    wrap="nowrap"
                    data-testid="activity-entry"
                  >
                    {earned !== null && (
                      <Text size="xs" c="teal" fw={600}>+{nf.format(earned)}</Text>
                    )}
                    <Text size="xs" style={{ flex: 1 }} truncate>{label}</Text>
                    <Text size="xs" c="dimmed">{time(event.ts)}</Text>
                  </Group>
                );
              })}
            </Stack>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}
