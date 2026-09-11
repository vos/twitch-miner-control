import { Badge, Group, Skeleton, Text, Tooltip } from "@mantine/core";
import { useEffect, useState } from "react";
import { averageLabel } from "../lib/averageLabel.js";
import { formatBytes } from "../lib/formatBytes.js";
import { formatUptime } from "../lib/formatUptime.js";
import { TRANSITIONAL, isKnown, isUp } from "../lib/minerState.js";
import { type ProcSample, averageOf } from "../lib/rollingHistory.js";
import { Sparkline } from "./Sparkline.js";

export interface MinerStatus {
  /**
   * Null until the first status poll answers.
   *
   * Deliberately not a sentinel string: a placeholder like "…" is neither
   * RUNNING nor transitional, so it falls through every check and leaves
   * an enabled Start button pointing at a miner that may already be up.
   * Null makes the unknown case one the type checker forces callers to
   * handle.
   */
  state: string | null;
  /** When the live miner started, or null if none is running. */
  startedAt: number | null;
}

/**
 * Read-only miner state for the header. The actions live in MinerDock at
 * the sidebar's foot; this half is what stays visible on mobile, where
 * the sidebar collapses into a slide-over.
 */
export function MinerStatusBadge(
  { state, startedAt, history = [] }: MinerStatus & { history?: readonly ProcSample[] },
) {
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
  const known = isKnown(state);
  const transitional = known && TRANSITIONAL.has(state);
  const latest = history[history.length - 1];
  const average = averageOf(history);
  // The graph plots raw samples while the number beside it is smoothed:
  // a 5s CPU reading jitters too much to read as a figure, but the
  // spikes it shows are the point of having a graph at all.
  const cpuSeries = history.map((s) => s.cpu ?? 0);

  return (
    <Group gap="xs" wrap="nowrap">
      {known ? (
        <Badge
          variant="light"
          color={up ? "teal" : transitional ? "twitch" : "orange"}
          data-testid="miner-state"
        >
          {state}
        </Badge>
      ) : (
        // Sized to a badge rather than to its text: an orange badge
        // reading "…" claims the miner is down before anything has said
        // so, and the header must not reflow when the real state lands.
        <Skeleton height={20} width={74} radius="xl" data-testid="miner-state-loading" />
      )}
      {startedAt !== null && (
        <Text size="sm" c="dimmed" ff="monospace" data-testid="miner-uptime">
          {formatUptime(Date.now() - startedAt)}
        </Text>
      )}
      {latest && (
        <Tooltip
          label={
            average === null
              ? "Miner process memory"
              : `Miner process: ${average.toFixed(0)}% CPU (${averageLabel(history.length)}), ${formatBytes(latest.rssBytes)} memory`
          }
        >
          <Group gap={6} wrap="nowrap" data-testid="miner-stats">
            {average !== null && (
              // Labelled by the window it actually covers, so a mean
              // taken over 15 seconds never claims to be a minute's.
              <Text size="sm" c="dimmed" ff="monospace">
                {average.toFixed(0)}% {averageLabel(history.length)}
              </Text>
            )}
            <Text size="sm" c="dimmed" ff="monospace">
              {formatBytes(latest.rssBytes)}
            </Text>
            {/* Hidden on narrow screens: the header is 56px tall and the
                numbers are what matter when space is short. Sparkline
                itself renders nothing below two points. */}
            <Group visibleFrom="sm" w={48}>
              <Sparkline
                values={cpuSeries}
                width={48}
                height={16}
                data-testid="miner-cpu-graph"
              />
            </Group>
          </Group>
        </Tooltip>
      )}
    </Group>
  );
}
