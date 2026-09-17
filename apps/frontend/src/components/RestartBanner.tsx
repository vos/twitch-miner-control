import { Affix, Button, Group, Paper, Text, Transition } from "@mantine/core";
import { IconRefreshAlert } from "@tabler/icons-react";
import { useEffect, useState } from "react";

export interface PendingRestartState {
  pending: boolean;
  /** Epoch ms the restart fires, or null when nothing is pending. */
  dueAt: number | null;
  reason: string | null;
}

/**
 * When the banner stops being a quiet notice.
 *
 * A minute out this is information; ten seconds out the miner is about
 * to drop its watch sessions, and someone who has not noticed the banner
 * yet needs a last chance to catch it.
 */
const URGENT_BELOW_S = 10;

/** Whole seconds left, floored at zero. */
function secondsLeft(dueAt: number): number {
  return Math.max(0, Math.round((dueAt - Date.now()) / 1000));
}

/**
 * The countdown before the engine restarts the miner.
 *
 * A restart drops the miner's accumulated watch-session state, so one
 * arriving unannounced reads as the app breaking. This says what is
 * about to happen, why, and offers both ways out -- stop it, or stop
 * waiting.
 *
 * Cancelling is "not right now", not "never": the engine's next pass
 * sees the same difference and proposes again.
 */
export function RestartBanner({
  state,
  onCancel,
  onNow,
}: {
  state: PendingRestartState;
  onCancel: () => void;
  onNow: () => void;
}) {
  const { dueAt } = state;
  const [left, setLeft] = useState(() =>
    dueAt === null ? null : secondsLeft(dueAt),
  );
  const urgent = left !== null && left <= URGENT_BELOW_S;

  useEffect(() => {
    if (dueAt === null) {
      setLeft(null);
      return;
    }
    setLeft(secondsLeft(dueAt));
    const timer = setInterval(() => setLeft(secondsLeft(dueAt)), 1000);
    return () => clearInterval(timer);
  }, [dueAt]);

  return (
    // Pinned rather than laid out, like PendingBar: the Drops list runs
    // to seventy campaigns, so a banner in the normal flow is off-screen
    // for the interaction that triggers it. Bottom rather than top so it
    // cannot cover the row just clicked, and offset by Mantine's navbar
    // variable, which already follows the sidebar collapsing.
    <Affix
      position={{ bottom: 24, right: 24 }}
      style={{
        pointerEvents: "none",
        left: "var(--app-shell-navbar-offset, 0px)",
      }}
    >
      {/* `mounted` rather than an early return, so it animates out as
          well as in, and stays absent from the DOM when idle. */}
      <Transition transition="slide-up" mounted={state.pending} duration={180}>
        {(styles) => (
          <Group justify="center" px="md" style={styles}>
            <Paper
              withBorder
              radius="md"
              px="md"
              py="sm"
              shadow="lg"
              maw="100%"
              bg="var(--tw-surface-alt)"
              data-testid="restart-banner"
              data-urgent={urgent}
              // Escalates within the warn colour rather than turning red:
              // --tw-live already means "a stream is live" across the
              // app, and one red meaning two things is what this page's
              // palette was untangled to avoid.
              style={{
                pointerEvents: "auto",
                borderColor: urgent ? "var(--tw-warn)" : undefined,
                boxShadow: urgent
                  ? "0 0 0 1px var(--tw-warn), var(--mantine-shadow-lg)"
                  : undefined,
              }}
            >
              <Group justify="space-between" wrap="wrap" gap="sm">
                <Group gap="sm" wrap="nowrap">
                  <IconRefreshAlert
                    size={18}
                    // Heavier as well as brighter: a thin glyph reads as
                    // decoration at the glance that matters.
                    stroke={urgent ? 2.4 : 1.7}
                    color="var(--tw-warn)"
                    aria-hidden
                  />
                  <div>
                    <Text
                      size={urgent ? "md" : "sm"}
                      fw={urgent ? 700 : 600}
                      c={urgent ? "var(--tw-warn)" : undefined}
                      data-testid="restart-countdown"
                    >
                      {/* Zero reads as "about to", not as a stalled
                          counter: the restart fires on the server's
                          clock, not this one. */}
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
                </Group>
                <Group gap="xs">
                  <Button size="xs" variant="default" onClick={onCancel}>
                    Cancel
                  </Button>
                  <Button size="xs" onClick={onNow}>
                    Restart now
                  </Button>
                </Group>
              </Group>
            </Paper>
          </Group>
        )}
      </Transition>
    </Affix>
  );
}
