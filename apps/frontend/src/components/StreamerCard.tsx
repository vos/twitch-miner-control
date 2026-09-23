import { Stack, Text } from "@mantine/core";
import { IconCoins } from "@tabler/icons-react";
import { Gain } from "./Gain.js";
import { RollingNumber } from "./RollingNumber.js";
import { Sparkline } from "./Sparkline.js";
import { StreamContext } from "./StreamContext.js";
import { ViewerCount } from "./ViewerCount.js";
import { StreamerAvatar } from "./StreamerAvatar.js";
import { StreamerMeta } from "./StreamerMeta.js";
import { StreamerTimes } from "./StreamerTimes.js";
import { useLiveDuration } from "../lib/useLiveDuration.js";
import { StatusPill } from "./StatusPill.js";
import classes from "./StreamerCard.module.css";
import type { StreamerState } from "../api/useLiveState.js";

export function StreamerCard({ streamer: s, onOpen, animate = false }: {
  streamer: StreamerState;
  onOpen?: () => void;
  /** Whether a change to this frame's balance may roll; see useBalanceMotion. */
  animate?: boolean;
}) {
  const live = s.isOnline === true;
  // Ticked here rather than below the sparkline: the badge already says
  // "this channel is live", and how long it has been live is the same
  // statement -- so the two belong in one element instead of repeating
  // each other down the card.
  const elapsed = useLiveDuration(live ? s.liveSince ?? null : null);
  return (
    <div
      className={`${classes.card} ${live ? classes.live : classes.offline}${
        onOpen ? ` ${classes.clickable}` : ""}`}
      data-testid={`streamer-${s.username}`}
      // The card is a button only when something is listening. Without a
      // handler it keeps its plain-div semantics rather than announcing
      // an action that does nothing.
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `Details for ${s.displayName ?? s.username}` : undefined}
      onClick={onOpen === undefined ? undefined : (event) => {
        // The card already holds a link to twitch.tv and the goal
        // disclosure button. A click that started inside either belongs
        // to it, not to the card.
        if ((event.target as HTMLElement).closest("a, button")) return;
        onOpen();
      }}
      onKeyDown={onOpen === undefined ? undefined : (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        // Space scrolls the page by default, which on a grid of cards
        // moves the very thing just activated.
        event.preventDefault();
        onOpen();
      }}
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

        {/* Balance left, the gains that explain it right. The coin is
            aria-hidden: the balance's own testid and the digits carry
            the fact, and a glyph announcing "coin" before every total
            would just add noise on a grid of cards. */}
        <div className={classes.balanceRow}>
          <Text className={classes.balance} data-testid="balance">
            {/* A stack of coins rather than a denominated one: these are
                channel points, not money, so a currency symbol on the
                glyph's face would be a wrong claim. */}
            <IconCoins className={classes.coin} stroke={2} aria-hidden />
            <RollingNumber value={s.points} animate={animate} />
          </Text>
          <div className={classes.gains}>
            {/* A zero stream gain is dropped, not printed. "0 stream"
                beside "0 24h" put two dead figures where the eye looks
                for deltas, and a stream that has earned nothing yet is
                adequately said by the absence. The 24h gain is NOT
                dropped the same way: it is the headline delta, and an
                empty right side would read as "not known yet" -- which
                is what the em-dash means here, a different claim. */}
            {live && s.gainedStream !== null && s.gainedStream !== 0 && (
              <Gain value={s.gainedStream} label="stream" testId="gain-stream" />
            )}
            <Gain value={s.gained24h} label="24h" since={s.gainedSince} testId="gain-24h" />
          </div>
        </div>

        {/* Fluid: the card's own width decides, so nothing is painted
            past its edge on a narrow column. */}
        <Sparkline values={s.spark} height={34} fill />

        <StreamerMeta streamer={s} />

        <StreamerTimes streamer={s} />

        {s.error && (
          <Text role="alert" size="xs" c="red">{s.error}</Text>
        )}
      </Stack>
    </div>
  );
}
