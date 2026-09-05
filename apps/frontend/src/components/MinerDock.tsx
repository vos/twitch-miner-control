import { Button, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { api } from "../api/client.js";
import { TRANSITIONAL, isUp } from "../lib/minerState.js";
import type { MinerStatus } from "./MinerStatusBadge.js";

/**
 * The miner's actions, pinned to the sidebar's foot.
 *
 * Full-width buttons and a real error line -- in the header these were
 * size="xs" with the message clamped to maw=180 behind a tooltip, which
 * is exactly the text an operator needs when a start fails.
 */
export function MinerDock({ state, onChange }: {
  state: string;
  onChange: (status: MinerStatus) => void;
}) {
  // Which action is in flight, so only the pressed button spins -- a
  // shared boolean would put a spinner on Restart when Stop was clicked.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "start" | "stop" | "restart") {
    setBusy(action);
    setError(null);
    try {
      // The route answers with the settled state, so the UI updates the
      // moment the action completes rather than showing the old state
      // until the next poll lands.
      onChange(await api.post<MinerStatus>(`/api/miner/${action}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const transitional = TRANSITIONAL.has(state);
  const up = isUp(state);

  return (
    <Stack gap="xs">
      {error && (
        <Text role="alert" size="xs" c="red" data-testid="miner-error">
          {error}
        </Text>
      )}
      <Button
        fullWidth
        size="sm"
        variant={up ? "default" : "filled"}
        color={up ? undefined : "teal"}
        data-testid="miner-toggle"
        disabled={transitional}
        loading={busy === (up ? "stop" : "start")}
        onClick={() => run(up ? "stop" : "start")}
      >
        {up ? "Stop" : "Start"}
      </Button>
      <Button
        fullWidth
        size="sm"
        variant="default"
        data-testid="miner-restart"
        disabled={transitional}
        loading={busy === "restart"}
        onClick={() => run("restart")}
      >
        Restart
      </Button>
    </Stack>
  );
}
