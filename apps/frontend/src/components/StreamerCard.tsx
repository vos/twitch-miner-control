import { Badge, Group, Stack, Text, Tooltip } from "@mantine/core";
import { Sparkline } from "./Sparkline.js";
import { StreamerAvatar } from "./StreamerAvatar.js";
import { StreamerTimes } from "./StreamerTimes.js";
import { formatSpan } from "../lib/formatSpan.js";
import { formatLiveSpan, useLiveDuration } from "../lib/useLiveDuration.js";
import classes from "./StreamerCard.module.css";
import type { StreamerState } from "../api/useLiveState.js";

const nf = new Intl.NumberFormat("en-US");

/**
 * Renders a gain.
 *
 * `null` means "we have no earlier balance to compare against" -- only
 * true on the very first poll of a newly added streamer -- and must not
 * render as "+0", which is a confident claim that nothing was earned.
 *
 * `since` carries the start of a window shorter than the nominal one, and
 * replaces the label with the span actually covered. A streamer tracked
 * for three hours has a real gain over a real window; it just is not a
 * day's worth, and saying "3h" reports that without withholding the
 * number until the 24h mark.
 */
function Gain({ value, label, since, testId }: {
  value: number | null;
  label: string;
  since?: number | null;
  testId: string;
}) {
  if (value === null) {
    return (
      <Text size="xs" c="dimmed" data-testid={testId}>— {label}</Text>
    );
  }
  const sign = value > 0 ? "+" : "";
  const window = since == null ? label : formatSpan(Date.now() - since);
  return (
    <Text size="xs" c={value > 0 ? "teal" : value < 0 ? "red" : "dimmed"} data-testid={testId}>
      {sign}{nf.format(value)} {window}
    </Text>
  );
}

export function StreamerCard({ streamer: s }: { streamer: StreamerState }) {
  const live = s.isOnline === true;
  // Ticked here rather than below the sparkline: the badge already says
  // "this channel is live", and how long it has been live is the same
  // statement -- so the two belong in one element instead of repeating
  // each other down the card.
  const elapsed = useLiveDuration(live ? s.liveSince ?? null : null);
  return (
    <div
      className={`${classes.card} ${live ? classes.live : classes.offline}`}
      data-testid={`streamer-${s.username}`}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <StreamerAvatar
              login={s.username}
              displayName={s.displayName}
              avatarUrl={s.avatarUrl}
              size={40}
              live={live}
            />
            {/* Its own link rather than one anchor around both: the name
                truncates and the avatar must not, so they cannot share a
                box, and a separate link keeps each one's accessible name
                honest. */}
            <Text
              component="a"
              href={`https://twitch.tv/${s.username}`}
              target="_blank"
              rel="noopener noreferrer"
              fw={600}
              truncate
              className={classes.name}
            >
              {s.displayName ?? s.username}
            </Text>
          </Group>
          <Group gap={6} wrap="nowrap">
            {live ? (
              <span className={classes.pill} data-testid="live-pill">
                <span className={classes.dot} />
                {elapsed === null ? "LIVE" : `LIVE ${formatLiveSpan(elapsed)}`}
              </span>
            ) : (
              /* The offline counterpart sits in the same slot so a card
                 keeps one status element whichever state it is in. It
                 carries the last time we saw the channel live -- which is
                 our own observation, not Twitch's history: the GQL layer
                 exposes a stream's createdAt only while it is running, so
                 a channel we have never seen live has no date to show and
                 reads a bare "offline". */
              <span
                className={`${classes.pill} ${classes.pillOffline}`}
                data-testid="offline-pill"
              >
                {s.lastLive == null
                  ? "OFFLINE"
                  : `OFFLINE ${formatSpan(Math.max(0, Date.now() - s.lastLive))}`}
              </span>
            )}
            {s.pointsEnabled === false && (
              <Tooltip label="Channel points are disabled for this channel, so the balance cannot move.">
                <Badge color="yellow" variant="light" size="sm" data-testid="points-disabled">
                  no points
                </Badge>
              </Tooltip>
            )}
          </Group>
        </Group>

        <Text className={classes.balance} data-testid="balance">
          {s.points === null ? "—" : nf.format(s.points)}
        </Text>

        {/* Fluid: the card's own width decides, so nothing is painted
            past its edge on a narrow column. */}
        <Sparkline values={s.spark} height={34} fill />

        <StreamerTimes streamer={s} />

        <Group gap="sm">
          {live && s.gainedStream !== null && (
            <Gain value={s.gainedStream} label="stream" testId="gain-stream" />
          )}
          <Gain value={s.gained24h} label="24h" since={s.gainedSince} testId="gain-24h" />
          {s.pointsPerHour !== null && (
            <Text size="xs" c="dimmed" data-testid="points-per-hour">
              {s.pointsPerHour}/h
            </Text>
          )}
        </Group>

        {s.error && (
          <Text role="alert" size="xs" c="red">{s.error}</Text>
        )}
      </Stack>
    </div>
  );
}
