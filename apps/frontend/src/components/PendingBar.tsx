import { Affix, Button, Group, Paper, Text, Transition } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

export function PendingBar({ count, onApply, busy }: {
  count: number; onApply: () => void; busy?: boolean;
}) {
  return (
    <Affix position={{ bottom: 24, left: 0, right: 0 }} style={{ pointerEvents: "none" }}>
      {/* `mounted` rather than an early return, so the bar animates out
          as well as in. It is still absent from the DOM at count 0. */}
      <Transition transition="slide-up" mounted={count > 0} duration={180}>
        {(styles) => (
          <Group justify="center" style={styles}>
            <Paper
              withBorder
              radius="xl"
              px="lg"
              py="sm"
              shadow="lg"
              data-testid="pending-bar"
              style={{ pointerEvents: "auto", background: "var(--tw-surface-alt)" }}
            >
              <Group gap="md" wrap="nowrap">
                <IconAlertTriangle size={18} stroke={1.7} color="var(--tw-warn)" />
                <Text size="sm">
                  {count} pending change{count === 1 ? "" : "s"} — the miner will restart
                </Text>
                <Button loading={busy} onClick={onApply} radius="xl">
                  Apply &amp; Restart
                </Button>
              </Group>
            </Paper>
          </Group>
        )}
      </Transition>
    </Affix>
  );
}
