import { Badge, Group, Popover, Skeleton, Stack, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useState } from "react";
import { averageLabel } from "../lib/averageLabel.js";
import { formatBytes } from "../lib/formatBytes.js";
import { formatUptime } from "../lib/formatUptime.js";
import { TRANSITIONAL, isKnown, isUp } from "../lib/minerState.js";
import { type ProcSample, averageOf } from "../lib/rollingHistory.js";
import { Sparkline } from "./Sparkline.js";
import classes from "./MinerStatusBadge.module.css";

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

/** One labelled figure in the detail panel. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Group justify="space-between" wrap="nowrap" gap="lg">
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="xs" ff="monospace">{value}</Text>
    </Group>
  );
}

/**
 * Splits a formatted figure into its digits and its units, so the header
 * can render the number at full strength and dim the unit beside it.
 *
 * Works on the formatters' own output rather than replacing them: the
 * detail panel still wants the plain string, and formatUptime's padding
 * rules (which keep a ticking clock from changing width) are not worth
 * reimplementing for a display concern.
 *
 * Splits on the boundary between a digit and a non-digit, keeps the
 * separators, and drops the spaces that "58 MB" and "16m 06s" carry --
 * the dimming does the separating, so the space would only loosen a pair
 * that should read as one object.
 */
function splitUnits(text: string): { text: string; unit: boolean }[] {
  return text
    .split(/([0-9.]+)/)
    .filter((part) => part !== "")
    .map((part) => ({
      text: /[0-9]/.test(part) ? part : part.replace(/\s+/g, ""),
      unit: !/[0-9]/.test(part),
    }))
    .filter((part) => part.text !== "");
}

/**
 * A figure in the header readout: bright digits, dimmed units.
 *
 * `title` carries the spelled-out reading, so the meaning survives for
 * anyone who finds "58MB" too terse -- and, unlike the popover, it is
 * available without opening anything.
 */
function Figure(
  { value, label, className, testId }:
  { value: string; label: string; className?: string; testId: string },
) {
  return (
    <Text
      size="sm"
      ff="monospace"
      className={className}
      title={`${label}: ${value}`}
      data-testid={testId}
    >
      {splitUnits(value).map((part, i) => (
        <span
          key={i}
          className={part.unit ? classes.unit : classes.value}
        >
          {part.text}
        </span>
      ))}
    </Text>
  );
}

/**
 * Read-only miner state for the header. The actions live in MinerDock at
 * the sidebar's foot; this half is what stays visible on mobile, where
 * the sidebar collapses into a slide-over.
 *
 * The readout is tiered by width. The header is a fixed 56px and on a
 * phone the burger and screen title leave it roughly 150px; rendering
 * every figure unconditionally overran that, wrapping the row onto three
 * lines that spilled out of the bar and clipping the state badge to
 * "R...".
 *
 * Always present: the state badge -- the reason the readout exists --
 * and the CPU percentage, which answers whether the miner is working and
 * how hard. The rest appear one at a time as room allows, in ascending
 * order of what they are worth when space is short:
 *
 *   uptime -> memory -> the CPU graph
 *
 * Uptime leads because "how long has this been up" is the question a
 * glance at a header is usually asking; the graph is last as the only
 * one the detail panel cannot restate in words. Thresholds live in the
 * CSS module, which explains how they were chosen -- deliberately NOT
 * the theme's `sm`, which is where the sidebar mounts and takes 240px
 * away.
 *
 * Nothing is actually lost on a phone: everything hidden is in the panel,
 * which opens on tap as well as hover.
 */
export function MinerStatusBadge(
  { state, startedAt, history = [] }: MinerStatus & { history?: readonly ProcSample[] },
) {
  // Re-render on a ticking clock so the uptime below is recomputed from
  // the current time. Without this it would only move when a new status
  // arrived from the 5s poll, so the seconds would jump in fives.
  const [, tick] = useState(0);
  // A Popover rather than the Tooltip this used to be: a tooltip opens on
  // hover only, so on a touch device -- the case that hides the most --
  // the detail was unreachable. This opens on tap and still on hover.
  const [opened, { open, close, toggle }] = useDisclosure(false);

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
  const uptime = startedAt === null ? null : formatUptime(Date.now() - startedAt);

  return (
    <Group gap="xs" wrap="nowrap">
      {known ? (
        <Badge
          variant="light"
          color={up ? "teal" : transitional ? "twitch" : "orange"}
          // Mantine's Badge is `flex-shrink: 1` over `overflow: hidden`,
          // so on a 320px screen it gave up three pixels and rendered
          // "RUNNI...". A truncated state is worse than no state at all:
          // "STOPPED" and "STARTING" both clip to "ST...". This is the
          // one element in the header that must never shrink.
          style={{ flexShrink: 0 }}
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
      {uptime !== null && (
        <Figure
          value={uptime}
          label="Uptime"
          className={classes.fromUptime}
          testId="miner-uptime"
        />
      )}
      {/* Divides uptime from the stats cluster. Tied to the uptime's own
          threshold: with nothing to its left there is nothing to divide. */}
      {uptime !== null && latest && (
        <span className={`${classes.divider} ${classes.fromUptime}`} aria-hidden />
      )}
      {latest && (
        <Popover
          opened={opened}
          onDismiss={close}
          position="bottom-end"
          withArrow
          shadow="md"
          width={200}
        >
          <Popover.Target>
            {/* A button rather than a bare div: this is the only route to
                the hidden figures on a phone, so it must be reachable by
                tap and by keyboard, and announce that it opens a panel. */}
            <UnstyledButton
              onMouseEnter={open}
              onMouseLeave={close}
              onClick={toggle}
              aria-label="Miner performance detail"
              aria-expanded={opened}
              data-testid="miner-stats"
            >
              <Group gap={10} wrap="nowrap">
                {/* CPU and its graph as one unit: the line plots this
                    percentage, and sitting at the far right past memory
                    it read as a third, unrelated figure. */}
                {average !== null && (
                  <Group gap={6} wrap="nowrap">
                    <Figure
                      value={`${average.toFixed(0)}%`}
                      label={`CPU, ${averageLabel(history.length)}`}
                      testId="miner-cpu"
                    />
                    {/* Last to appear: the numbers are what matter when
                        space is short. Sparkline renders nothing below
                        two points, so this can be empty at any width. */}
                    <Group className={classes.fromGraph} w={48}>
                      <Sparkline
                        values={cpuSeries}
                        width={48}
                        height={16}
                        data-testid="miner-cpu-graph"
                      />
                    </Group>
                  </Group>
                )}
                {/* The window the average covers is no longer on the line:
                    "2% 1m avg" was the phrase that made the readout parse
                    as prose, and it qualifies a figure rather than being
                    one. The panel and this figure's title still state it,
                    so a mean over 15 seconds never silently claims a
                    minute's -- see averageLabel. */}
                <span className={`${classes.divider} ${classes.fromMemory}`} aria-hidden />
                <Figure
                  value={formatBytes(latest.rssBytes)}
                  label="Memory"
                  className={classes.fromMemory}
                  testId="miner-memory"
                />
              </Group>
            </UnstyledButton>
          </Popover.Target>
          {/* Every figure, including the ones the header still shows: a
              panel that listed only what was hidden would change contents
              with the viewport, so what it reports would depend on the
              width it was opened at. */}
          <Popover.Dropdown>
            <Stack gap={6} data-testid="miner-stats-detail">
              {average !== null && (
                <DetailRow
                  label={`CPU · ${averageLabel(history.length)}`}
                  value={`${average.toFixed(0)}%`}
                />
              )}
              <DetailRow label="Memory" value={formatBytes(latest.rssBytes)} />
              {uptime !== null && <DetailRow label="Uptime" value={uptime} />}
            </Stack>
          </Popover.Dropdown>
        </Popover>
      )}
    </Group>
  );
}
