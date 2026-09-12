import { Badge, Group, Progress, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import classes from "./StreamerMeta.module.css";
import type { StreamerState } from "../api/useLiveState.js";

const nf = new Intl.NumberFormat("en-US");

/**
 * The badge strip between the sparkline and the time block.
 *
 * It exists because the title row is identity: an avatar, a name that
 * must be allowed to truncate, and the one pill saying whether the
 * channel is live. Every other signal competed with the name for that
 * row's width, so they live here instead and the title row stops
 * growing as signals are added.
 *
 * The row is deliberately two kinds of thing, not one list of chips:
 * context on the left (dimmed, truncates first) and badges on the right
 * (fixed, never truncate). At 320px -- the dashboard's minimum column --
 * that is what decides the category gets clipped and the multiplier
 * does not, rather than whichever happened to be last.
 */
export function StreamerMeta({ streamer: s }: { streamer: StreamerState }) {
  const [open, setOpen] = useState(false);

  // Read defensively, like StreamerTimes: a snapshot from a backend that
  // predates these fields -- or any frame that drops one -- arrives with
  // them `undefined`, and a strict `!== null` test lets undefined through
  // to a property access that takes the whole dashboard down.
  const goal = s.goal ?? null;
  const multiplier = s.multiplier ?? null;
  const claimPending = s.claimPending ?? false;
  const watching = s.watching ?? false;
  // Offline: nothing is being mined, so nothing is being multiplied.
  const idle = s.isOnline !== true;

  const badges = (
    <>
      {multiplier !== null && (
        <Tooltip
          label={
            idle
              ? "This channel's points multiplier applies once it goes live again."
              : "Your channel points are multiplied on this channel, usually from a subscription."
          }
        >
          {/* Kept on an offline card rather than hidden: a multiplier is a
              standing property of the channel, and dropping it would make
              the badge flicker with live state. Dimmed instead, because it
              cannot multiply anything while nothing is being mined. */}
          <Badge
            color="grape"
            variant="light"
            size="sm"
            data-testid="multiplier"
            data-idle={idle}
            className={classes.multiplier}
          >
            ×{multiplier}
          </Badge>
        </Tooltip>
      )}
      {claimPending && (
        <Tooltip label="A points bonus is waiting to be claimed on this channel.">
          <Badge color="teal" variant="light" size="sm" data-testid="claim-pending">
            claim
          </Badge>
        </Tooltip>
      )}
      {watching && (
        <Tooltip label="The miner is currently watching this channel.">
          <Badge color="twitch" variant="light" size="sm" data-testid="watching-badge">
            watching
          </Badge>
        </Tooltip>
      )}
      {s.pointsEnabled === false && (
        <Tooltip label="Channel points are disabled for this channel, so the balance cannot move.">
          <Badge color="yellow" variant="light" size="sm" data-testid="points-disabled">
            no points
          </Badge>
        </Tooltip>
      )}
    </>
  );

  // An empty strip still costs a row gap on every card that has none of
  // these, so the whole thing is omitted rather than rendered blank.
  const hasBadges = multiplier !== null || claimPending || watching
    || s.pointsEnabled === false;
  if (!hasBadges && goal === null) return null;

  return (
    <>
      {hasBadges && (
        <Group gap={6} wrap="nowrap" data-testid="meta-row" className={classes.row}>
          <Group gap={6} wrap="nowrap" className={classes.badges}>{badges}</Group>
        </Group>
      )}

      {goal !== null && (
        <div className={classes.goal}>
          {/* Behind a disclosure: a title, a bar and two figures is a
              third of a narrow card's height for a figure that moves
              hourly, and it is the one signal here nobody acts on. */}
          <UnstyledButton
            className={classes.goalToggle}
            data-testid="goal-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            <span className={classes.goalCaret} data-open={open}>▸</span>
            <span className={classes.goalTitle}>{goal.title}</span>
            <span className={classes.goalPct}>
              {Math.round((goal.contributed / goal.needed) * 100)}%
            </span>
          </UnstyledButton>
          {open && (
            <div data-testid="goal-progress">
              <Progress
                value={(goal.contributed / goal.needed) * 100}
                color="grape"
                size="sm"
                aria-label={`${goal.title} progress`}
              />
              <Text size="xs" c="dimmed" mt={4}>
                {nf.format(goal.contributed)} of {nf.format(goal.needed)}
              </Text>
            </div>
          )}
        </div>
      )}
    </>
  );
}
