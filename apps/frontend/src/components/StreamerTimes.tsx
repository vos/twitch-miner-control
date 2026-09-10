import { Group, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { formatSpan } from "../lib/formatSpan.js";
import { parseActivity } from "../lib/parseActivity.js";
import classes from "./StreamerCard.module.css";
import type { StreamerState } from "../api/useLiveState.js";

const ago = (ts: number, now: number) => `${formatSpan(Math.max(0, now - ts))} ago`;

/** Grouped, so a five-figure claim does not read as a wall of digits. */
const nf = new Intl.NumberFormat("en-US");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How recent an event has to be to render as "just happened".
 *
 * Five minutes because this component re-renders on a one-minute timer:
 * a threshold finer than that would leave a card claiming freshness for
 * up to a minute after it lapsed. It is also comfortably above the
 * miner's own watch-gain cadence, so an actively mined channel stays
 * marked between gains rather than flickering.
 */
const FRESH = 5 * MINUTE;

/**
 * A duration of *work done*, rounded down.
 *
 * formatSpan is built for labelling a gain window, where "about an hour"
 * is the point, so it rounds to nearest and floors at "1m": 30 minutes
 * renders "1h" and zero renders "1m". Both are wrong for a mining
 * figure, which is a claim about time actually spent -- rounding up
 * overstates it by as much as 2x, and this figure exists precisely to
 * show when mining time is short or missing.
 *
 * So: truncate, and let a genuine zero read "0m".
 */
function duration(ms: number): string {
  if (ms < MINUTE) return "0m";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/**
 * The time block under a card's sparkline: last activity and mining time.
 *
 * Neither "how long has this channel been live" nor "when was it last
 * live" is here: both live in the status badge, which already asserts
 * which state the channel is in and so is the natural place to say since
 * when. Rendering either here as well printed the same fact twice down
 * one card.
 */
export function StreamerTimes({ streamer: s }: { streamer: StreamerState }) {
  // A minute is enough: every string here is minute-granular or coarser,
  // and the live duration itself now lives in the LIVE badge.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Every field is read defensively. A snapshot from a backend that
  // predates these fields -- or any frame that drops one -- must degrade
  // to a card without a time block, never take the whole dashboard down
  // with it. `?? null` rather than `?.` alone so the render conditions
  // below stay strict null checks.
  const lastActivity = s.lastActivity ?? null;

  // Taken as sent. The card must NOT add the running stream to these:
  // mining time is the intersection of "channel live" and "miner up",
  // and this side knows only the first half. Adding the live stream
  // here assumed the miner had been up for all of it, so a miner
  // started ten minutes into a day-long stream reported a full day.
  const mined24h = s.mined24h ?? 0;
  const minedTotal = s.minedTotal ?? 0;

  // Online time is deliberately not shown here. For a single ongoing
  // stream it is the same fact as the uptime above -- and worse, clipped
  // to the window, so a channel up for 27 hours read "live 24h" beside
  // its own "1d 03h" uptime. The uptime line already answers "how long
  // has this channel been live"; this line answers "how much of it did
  // we mine", which is the number the uptime cannot give.
  // Also shown on an offline card with mining history, so the pair of
  // figures stays in the same place whichever state the card is in --
  // an all-time total sitting alone on one side reads as a stray number.
  // A channel we have never mined shows neither.
  const has24h = mined24h > 0 || s.isOnline === true || minedTotal > 0;
  // Gated separately from the 24h figures: a channel that streamed
  // heavily last week and not since still has a real all-time total, and
  // hiding it because the last day was quiet would lose that.
  const hasTotal = minedTotal > 0;

  return (
    <>
      {lastActivity !== null && (
        <div
          className={`${classes.lastEvent} ${
            now - lastActivity.ts < FRESH ? classes.fresh : ""
          }`}
          data-testid="last-activity"
          data-fresh={now - lastActivity.ts < FRESH ? "true" : "false"}
        >
          <span className={classes.eventDot} />
          <span className={classes.eventTag}>LAST</span>
          {(() => {
            // The amount is the one genuinely new fact the message carries;
            // the label alone never said how much arrived.
            const { earned, label } = parseActivity(lastActivity.type, lastActivity.message);
            return (
              <>
                {earned !== null && (
                  <span className={classes.eventGain} data-testid="last-activity-gain">
                    +{nf.format(earned)}
                  </span>
                )}
                <span className={classes.eventName}>{label}</span>
              </>
            );
          })()}
          <span className={classes.eventAge}>{ago(lastActivity.ts, now)}</span>
        </div>
      )}

      {(has24h || hasTotal) && (
        <Group justify="space-between" gap="xs" wrap="nowrap">
          {has24h && (
            <Text size="xs" c="dimmed" data-testid="times-24h">
              mined {duration(mined24h)} of 24h
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
