import { Group, Stack, Text } from "@mantine/core";
import { Sparkline } from "./Sparkline.js";
import { StreamContext } from "./StreamContext.js";
import { ViewerCount } from "./ViewerCount.js";
import { StreamerAvatar } from "./StreamerAvatar.js";
import { StreamerMeta } from "./StreamerMeta.js";
import { StreamerTimes } from "./StreamerTimes.js";
import { formatSpan } from "../lib/formatSpan.js";
import { useLiveDuration } from "../lib/useLiveDuration.js";
import { StatusPill } from "./StatusPill.js";
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
        {/* A grid, not nested rows. The pill is a real sibling on the
            name's row, so with flex the text column could only ever have
            the width the pill left it -- 174px of a 320px card -- and the
            category truncated with empty space beside it.

            Here the avatar spans both rows, the name shares row 1 with
            the pill, and row 2 pairs the category with the viewer count
            under the pill: the category starts beside the avatar and
            takes the free width, the count stays a figure in a column
            with the pill rather than trailing the prose. */}
        <div className={classes.identity} data-testid="identity">
          <div className={classes.avatarCell}>
            <StreamerAvatar
              login={s.username}
              displayName={s.displayName}
              avatarUrl={s.avatarUrl}
              size={40}
              live={live}
            />
          </div>
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
          {/* Status only. Every other signal moved to StreamerMeta so
              this row stays identity + live state and the name keeps its
              width as signals are added. */}
          <StatusPill
            isOnline={s.isOnline}
            liveSince={s.liveSince}
            lastLive={s.lastLive}
            elapsed={live ? elapsed : null}
          />
          <div className={classes.contextCell}>
            <StreamContext game={s.game ?? null} title={s.streamTitle ?? null} />
          </div>
          {/* Its own cell under the pill: a figure belongs in a column
              with the other figure above it, not trailing a line of prose
              that truncates before it. */}
          <div className={classes.viewersCell}>
            <ViewerCount viewers={s.viewers ?? null} />
          </div>
        </div>

        <Text className={classes.balance} data-testid="balance">
          {s.points === null ? "—" : nf.format(s.points)}
        </Text>

        {/* Fluid: the card's own width decides, so nothing is painted
            past its edge on a narrow column. */}
        <Sparkline values={s.spark} height={34} fill />

        <StreamerMeta streamer={s} />

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
