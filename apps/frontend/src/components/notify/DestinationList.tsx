import { Badge, Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import type { Destination } from "../../api/notify.js";
import { formatSpan } from "../../lib/formatSpan.js";
import { TestButton } from "./TestButton.js";

function status(d: Destination, now: number): { text: string; error: boolean } {
  if (d.lastError !== null) return { text: `Last delivery failed: ${d.lastError}`, error: true };
  if (d.lastOkTs !== null) return { text: `Last delivered ${formatSpan(now - d.lastOkTs)} ago`, error: false };
  return { text: "Nothing delivered yet", error: false };
}

/** Every destination other than this browser. */
export function DestinationList({
  destinations, selectedId, onSelect, onTest, onToggle, onRemove,
}: {
  destinations: Destination[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onTest: (id: string) => Promise<string | null>;
  onToggle: (destination: Destination) => void;
  onRemove: (id: string) => void;
}) {
  const now = Date.now();
  return (
    <Card withBorder>
      <Stack gap="md">
        <Title order={4}>Other devices</Title>
        {destinations.length === 0 && (
          <Text size="sm" c="dimmed">
            No other browser has notifications on. Open this page on another device to turn them on
            there.
          </Text>
        )}
        {destinations.map((d) => {
          const s = status(d, now);
          return (
            <Stack key={d.id} gap={4} data-testid={`destination-${d.id}`}>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs">
                  <Text fw={600}>{d.label}</Text>
                  {!d.enabled && <Badge variant="light" color="gray">Paused</Badge>}
                </Group>
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="xs"
                    variant={d.id === selectedId ? "filled" : "default"}
                    onClick={() => onSelect(d.id)}
                  >
                    Edit events
                  </Button>
                  <Button size="xs" variant="default" onClick={() => onToggle(d)}>
                    {d.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button size="xs" variant="subtle" color="red" onClick={() => onRemove(d.id)}>
                    Remove
                  </Button>
                </Group>
              </Group>
              <Group gap="xs">
                <Text size="sm" c={s.error ? "red" : "dimmed"}>{s.text}</Text>
                <TestButton size="xs" onTest={() => onTest(d.id)} />
              </Group>
            </Stack>
          );
        })}
      </Stack>
    </Card>
  );
}
