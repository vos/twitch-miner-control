import { Group, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { formatSpan } from "../lib/formatSpan.js";
import { formatUptime } from "../lib/formatUptime.js";
import type { StreamerState } from "../api/useLiveState.js";

/**
 * Turns GAIN_FOR_CLAIM into "claim".
 *
 * The card wants a short label; the events feed already renders the
 * miner's own full line, so repeating it here would just truncate badly.
 */
function activityLabel(type: string): string {
  return type.toLowerCase().replace(/^gain_for_/, "").replace(/_/g, " ");
}

const ago = (ts: number, now: number) => `${formatSpan(Math.max(0, now - ts))} ago`;

/**
 * A duration, where a genuine zero stays zero.
 *
 * formatSpan floors at "1m" -- right for an elapsed window, which is
 * never truly zero -- but wrong here: "mined 1m" for a miner that has
 * not run at all is a small lie, and this figure exists precisely to
 * show when mining time is missing.
 */
const duration = (ms: number) => (ms < 60_000 ? "0m" : formatSpan(ms));

/**
 * The time block under a card's sparkline.
 *
 * Two things are deliberately computed here rather than sent:
 *
 * The live duration ticks from `liveSince`, a timestamp. A server-sent
 * duration would change on every poll and wake every SSE client with a
 * frame carrying nothing new.
 *
 * The 24h and all-time figures arrive measured only up to the *current
 * stream's start*, for the same reason -- an open span grows with the
 * wall clock. So this adds the running stream's own elapsed time back on,
 * which it can do exactly because `liveSince` is already ticking.
 */
export function StreamerTimes({ streamer: s }: { streamer: StreamerState }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Nothing ticks on an offline card, so it costs no timer at all.
    if (s.liveSince == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [s.liveSince]);

  // Every field is read defensively. A snapshot from a backend that
  // predates these fields -- or any frame that drops one -- must degrade
  // to a card without a time block, never take the whole dashboard down
  // with it. `?? null` rather than `?.` alone so the render conditions
  // below stay strict null checks.
  const liveSince = s.liveSince ?? null;
  const lastLive = s.lastLive ?? null;
  const lastActivity = s.lastActivity ?? null;

  const live = liveSince === null ? 0 : Math.max(0, now - liveSince);

  // Taken as sent. The card must NOT add the running stream to these:
  // mining time is the intersection of "channel live" and "miner up",
  // and this side knows only the first half. Adding the live stream
  // here assumed the miner had been up for all of it, so a miner
  // started ten minutes into a day-long stream reported a full day.
  const online24h = s.online24h ?? 0;
  const mined24h = s.mined24h ?? 0;
  const minedTotal = s.minedTotal ?? 0;

  // A gap smaller than a rounding step is not a gap worth two numbers.
  const gap = online24h - mined24h >= 60_000;
  const has24h = online24h > 0 || mined24h > 0;
  // Gated separately from the 24h figures: a channel that streamed
  // heavily last week and not since still has a real all-time total, and
  // hiding it because the last day was quiet would lose that.
  const hasTotal = minedTotal > 0;

  return (
    <>
      {(liveSince !== null || lastLive !== null || lastActivity !== null) && (
        <Group justify="space-between" gap="xs" wrap="nowrap">
          {liveSince !== null && (
            <Text size="xs" c="dimmed" data-testid="live-duration">
              {formatUptime(live)}
            </Text>
          )}
          {liveSince === null && lastLive !== null && (
            <Text size="xs" c="dimmed" data-testid="last-live">
              last live {ago(lastLive, now)}
            </Text>
          )}
          {lastActivity !== null && (
            <Text size="xs" c="dimmed" truncate data-testid="last-activity">
              {activityLabel(lastActivity.type)} {ago(lastActivity.ts, now)}
            </Text>
          )}
        </Group>
      )}

      {(has24h || hasTotal) && (
        <Group justify="space-between" gap="xs" wrap="nowrap">
          {has24h && (
            <Text size="xs" c="dimmed" data-testid="times-24h">
              {gap ? `live ${duration(online24h)} · ` : ""}
              mined {duration(mined24h)}
            </Text>
          )}
          {hasTotal && (
            <Text size="xs" c="dimmed" data-testid="mined-total">
              {duration(minedTotal)} all-time
            </Text>
          )}
        </Group>
      )}
    </>
  );
}
