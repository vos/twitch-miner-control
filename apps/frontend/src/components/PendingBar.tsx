import { Affix, Button, Group, Paper, Text } from "@mantine/core";

export function PendingBar({ count, onApply, busy }: {
  count: number; onApply: () => void; busy?: boolean;
}) {
  if (count === 0) return null;
  return (
    <Affix position={{ bottom: 0, left: 0, right: 0 }}>
      <Paper withBorder p="sm" radius={0} data-testid="pending-bar">
        <Group justify="space-between">
          <Text size="sm">
            {count} pending change{count === 1 ? "" : "s"} — the miner will restart
          </Text>
          <Button loading={busy} onClick={onApply}>Apply &amp; Restart</Button>
        </Group>
      </Paper>
    </Affix>
  );
}
