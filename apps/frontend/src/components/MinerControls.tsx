import { Badge, Button, Group, Text, Tooltip } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { formatUptime } from "../lib/formatUptime.js";

export interface MinerStatus {
  state: string;
  /** When the live miner started, or null if none is running. */
  startedAt: number | null;
}

/**
 * States in which the miner is between lives: no process to stop, and
 * nothing useful to start on top of the one the supervisor is already
 * working towards. The toggle is disabled here rather than hidden, so the
 * controls keep their width and the header does not reflow on every
 * transition.
 */
const TRANSITIONAL = new Set(["STARTING", "RESTARTING"]);

/** The miner is up: the only sensible toggle is to bring it down. */
const isUp = (state: string) => state === "RUNNING";

export function MinerControls({ state, startedAt, onChange }: {
  state: string;
  startedAt: number | null;
  onChange: (status: MinerStatus) => void;
}) {
  // Which action is in flight, so only the pressed button spins -- a shared
  // boolean would put a spinner on Restart when Stop was clicked.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Re-render on a ticking clock so the uptime below is recomputed from the
  // current time. Without this the timer would only move when a new status
  // arrived from the 5s poll, so the seconds would jump in fives.
  const [, tick] = useState(0);

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  async function run(action: "start" | "stop" | "restart") {
    setBusy(action);
    setError(null);
    try {
      // The route answers with the settled state, so the header updates the
      // moment the action completes rather than showing the old state until
      // the next poll lands.
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
    <Group gap="xs" wrap="nowrap">
      {error && (
        // Terse by necessity -- this sits in a fixed-height header. The full
        // message is in the tooltip and the miner log has the detail.
        <Tooltip label={error} multiline w={260}>
          <Text role="alert" c="red" size="xs" data-testid="miner-error" lineClamp={1} maw={180}>
            {error}
          </Text>
        </Tooltip>
      )}
      <Badge color={up ? "green" : transitional ? "blue" : "orange"} data-testid="miner-state">
        {state}
      </Badge>
      {startedAt !== null && (
        <Text size="sm" c="dimmed" data-testid="miner-uptime" ff="monospace">
          {formatUptime(Date.now() - startedAt)}
        </Text>
      )}
      <Button
        size="xs"
        variant={up ? "default" : "filled"}
        color={up ? undefined : "green"}
        data-testid="miner-toggle"
        disabled={transitional}
        loading={busy === (up ? "stop" : "start")}
        onClick={() => run(up ? "stop" : "start")}
      >
        {up ? "Stop" : "Start"}
      </Button>
      <Button
        size="xs"
        variant="default"
        data-testid="miner-restart"
        disabled={transitional}
        loading={busy === "restart"}
        onClick={() => run("restart")}
      >
        Restart
      </Button>
    </Group>
  );
}
