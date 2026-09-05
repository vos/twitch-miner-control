import { Badge, Card, Group, Stack, Text, Tooltip } from "@mantine/core";
import { Sparkline } from "./Sparkline.js";
import type { StreamerState } from "../api/useLiveState.js";

const nf = new Intl.NumberFormat("en-US");

/**
 * Renders a gain.
 *
 * `null` means "we have no earlier balance to compare against" -- a fresh
 * install, or a streamer added minutes ago -- and must not render as "+0",
 * which is a confident claim that nothing was earned.
 */
function Gain({ value, label, testId }: { value: number | null; label: string; testId: string }) {
  if (value === null) {
    return (
      <Text size="xs" c="dimmed" data-testid={testId}>— {label}</Text>
    );
  }
  const sign = value > 0 ? "+" : "";
  return (
    <Text size="xs" c={value > 0 ? "teal" : value < 0 ? "red" : "dimmed"} data-testid={testId}>
      {sign}{nf.format(value)} {label}
    </Text>
  );
}

export function StreamerCard({ streamer: s }: { streamer: StreamerState }) {
  return (
    <Card withBorder data-testid={`streamer-${s.username}`}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600} truncate>{s.displayName ?? s.username}</Text>
          {s.pointsEnabled === false && (
            <Tooltip label="Channel points are disabled for this channel, so the balance cannot move.">
              <Badge color="yellow" variant="light" size="sm" data-testid="points-disabled">
                no points
              </Badge>
            </Tooltip>
          )}
        </Group>

        <Group justify="space-between" align="flex-end" wrap="nowrap">
          <Text size="lg" data-testid="balance">
            {s.points === null ? "—" : nf.format(s.points)}
          </Text>
          <Sparkline values={s.spark} />
        </Group>

        <Group gap="sm">
          {s.isOnline && s.gainedStream !== null && (
            <Gain value={s.gainedStream} label="stream" testId="gain-stream" />
          )}
          <Gain value={s.gained24h} label="24h" testId="gain-24h" />
        </Group>

        {s.error && (
          <Text role="alert" size="xs" c="red">{s.error}</Text>
        )}
      </Stack>
    </Card>
  );
}
