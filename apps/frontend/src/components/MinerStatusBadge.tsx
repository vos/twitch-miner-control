import { Badge, Group, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { formatUptime } from "../lib/formatUptime.js";
import { TRANSITIONAL, isUp } from "../lib/minerState.js";

export interface MinerStatus {
  state: string;
  /** When the live miner started, or null if none is running. */
  startedAt: number | null;
}

/**
 * Read-only miner state for the header. The actions live in MinerDock at
 * the sidebar's foot; this half is what stays visible on mobile, where
 * the sidebar collapses into a slide-over.
 */
export function MinerStatusBadge({ state, startedAt }: MinerStatus) {
  // Re-render on a ticking clock so the uptime below is recomputed from
  // the current time. Without this it would only move when a new status
  // arrived from the 5s poll, so the seconds would jump in fives.
  const [, tick] = useState(0);

  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const up = isUp(state);
  const transitional = TRANSITIONAL.has(state);

  return (
    <Group gap="xs" wrap="nowrap">
      <Badge
        variant="light"
        color={up ? "teal" : transitional ? "twitch" : "orange"}
        data-testid="miner-state"
      >
        {state}
      </Badge>
      {startedAt !== null && (
        <Text size="sm" c="dimmed" ff="monospace" data-testid="miner-uptime">
          {formatUptime(Date.now() - startedAt)}
        </Text>
      )}
    </Group>
  );
}
