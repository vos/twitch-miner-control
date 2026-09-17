import { Alert, Button, Group, Text } from "@mantine/core";
import { IconRefreshAlert } from "@tabler/icons-react";
import { useEffect, useState } from "react";

export interface PendingRestartState {
  pending: boolean;
  /** Epoch ms the restart fires, or null when nothing is pending. */
  dueAt: number | null;
  reason: string | null;
}

/** Whole seconds left, floored at zero. */
function secondsLeft(dueAt: number): number {
  return Math.max(0, Math.round((dueAt - Date.now()) / 1000));
}

/**
 * The countdown before the engine restarts the miner.
 *
 * A restart drops the miner's accumulated watch-session state, so one
 * arriving unannounced while someone is watching the dashboard reads as
 * the app breaking. This says what is about to happen, why, and offers
 * both ways out -- stop it, or stop waiting.
 *
 * Cancelling is "not right now", not "never": the engine's next pass
 * sees the same difference and proposes again.
 */
export function RestartBanner({ state, onCancel, onNow }: {
  state: PendingRestartState;
  onCancel: () => void;
  onNow: () => void;
}) {
  const { dueAt } = state;
  const [left, setLeft] = useState(() =>
    dueAt === null ? null : secondsLeft(dueAt));

  useEffect(() => {
    if (dueAt === null) {
      setLeft(null);
      return;
    }
    setLeft(secondsLeft(dueAt));
    const timer = setInterval(() => setLeft(secondsLeft(dueAt)), 1000);
    return () => clearInterval(timer);
  }, [dueAt]);

  if (!state.pending) return null;

  return (
    <Alert
      color="orange"
      icon={<IconRefreshAlert />}
      data-testid="restart-banner"
    >
      <Group justify="space-between" wrap="wrap" gap="sm">
        <div>
          <Text size="sm" fw={600} data-testid="restart-countdown">
            {/* Zero reads as "about to", not as a stalled counter -- the
                restart fires on the server's clock, not this one. */}
            {left === null
              ? "Restarting the miner"
              : left === 0
                ? "Restarting the miner now"
                : `Restarting the miner in ${left}s`}
          </Text>
          {state.reason !== null && (
            <Text size="xs" c="dimmed" data-testid="restart-reason">
              {state.reason}
            </Text>
          )}
        </div>
        <Group gap="xs">
          <Button size="xs" variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="xs" color="orange" onClick={onNow}>
            Restart now
          </Button>
        </Group>
      </Group>
    </Alert>
  );
}
