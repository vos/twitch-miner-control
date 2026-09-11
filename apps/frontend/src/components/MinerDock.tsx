import { Button, Skeleton, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { api } from "../api/client.js";
import { TRANSITIONAL, isKnown, isUp } from "../lib/minerState.js";
import type { MinerStatus } from "./MinerStatusBadge.js";

/**
 * The miner's actions, pinned to the sidebar's foot.
 *
 * Full-width buttons and a real error line -- in the header these were
 * size="xs" with the message clamped to maw=180 behind a tooltip, which
 * is exactly the text an operator needs when a start fails.
 */
export function MinerDock({ state, onChange }: {
  /** Null until the first status poll answers -- see MinerStatus. */
  state: string | null;
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

  const known = isKnown(state);
  const transitional = known && TRANSITIONAL.has(state);
  const up = isUp(state);
  // Until the state is known there is no action to offer: the labels
  // below would assert a state we have not been told yet, and Start on
  // an already-running miner is the one misclick this dock must not
  // allow. Disabled rather than hidden, so the sidebar keeps its height
  // -- the same reason a transitional state disables instead of hiding.
  const pending = !known;

  /** A label-shaped placeholder, sized to the text it stands in for. */
  const placeholder = <Skeleton height={9} width={54} radius="xl" />;

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
        color={pending ? "gray" : up ? undefined : "teal"}
        data-testid="miner-toggle"
        disabled={pending || transitional}
        loading={busy === (up ? "stop" : "start")}
        onClick={() => run(up ? "stop" : "start")}
      >
        {pending ? placeholder : up ? "Stop" : "Start"}
      </Button>
      <Button
        fullWidth
        size="sm"
        variant="default"
        data-testid="miner-restart"
        disabled={pending || transitional}
        loading={busy === "restart"}
        onClick={() => run("restart")}
      >
        {pending ? placeholder : "Restart"}
      </Button>
    </Stack>
  );
}
