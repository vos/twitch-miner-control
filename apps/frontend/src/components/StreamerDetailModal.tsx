import { Alert, Button, Group, Modal, SegmentedControl, Skeleton, Stack, Text } from "@mantine/core";
import { IconActivity, IconCoins } from "@tabler/icons-react";
import { useState } from "react";
import { useLiveSchedule } from "../api/useLiveSchedule.js";
import { useStreamerDetail } from "../api/useStreamerDetail.js";
import {
  RANGE_KEYS, RANGE_LABELS, rangeWindow, type RangeKey,
} from "../lib/detailRanges.js";
import { CoverageTimeline } from "./CoverageTimeline.js";
import { Gain } from "./Gain.js";
import { LiveSchedule } from "./LiveSchedule.js";
import { PointsChart } from "./PointsChart.js";
import { RollingNumber } from "./RollingNumber.js";
import { StatusPill } from "./StatusPill.js";
import { StreamerActivityLog } from "./StreamerActivityLog.js";
import { StreamerAvatar } from "./StreamerAvatar.js";
import { StreamHistoryTable } from "./StreamHistoryTable.js";
import classes from "./StreamerDetailModal.module.css";
import type { StreamerState } from "../api/useLiveState.js";

/** Rows in the coverage strip per range. Capped at two weeks: thirty rows
 *  of bands is taller than the dialog. */
const COVERAGE_DAYS: Record<RangeKey, number> = { "24h": 1, "7d": 7, "30d": 14, all: 14 };

/**
 * The deep view of one streamer: the history SQLite has been recording
 * all along and the card has no room for.
 *
 * The header renders from the dashboard's own snapshot rather than the
 * fetch, so it paints the instant the dialog opens and only the charts
 * below it wait on the network.
 */
export function StreamerDetailModal({ streamer, opened, onClose, animateBalance = false }: {
  streamer: StreamerState | null;
  opened: boolean;
  onClose: () => void;
  /** Whether a change to the balance may roll; see useBalanceMotion. */
  animateBalance?: boolean;
}) {
  // The last streamer shown outlives the selection. The dashboard clears
  // its selection on close, and unmounting in that same render would cut
  // the exit transition and skip Mantine returning focus to the card.
  const [shown, setShown] = useState(streamer);
  // Only a DIFFERENT channel is worth a state update. The dashboard
  // derives this prop with `snapshot.streamers.find(...)` and rebuilds
  // the snapshot on every SSE frame, so the old reference test was true
  // on every frame for an unchanged channel -- a render-phase setState
  // firing several times a minute to store an equivalent object.
  //
  // `shown` is therefore only a fallback for the closing animation, and
  // never what a live figure is read from: `streamer ?? shown` prefers
  // the fresh prop whenever there is one, so points and the LIVE clock
  // keep ticking while the dialog is open.
  if (streamer !== null && streamer.username !== shown?.username) setShown(streamer);
  const s = streamer ?? shown;

  const [range, setRange] = useState<RangeKey>("7d");
  // The feed is a separate view rather than a fourth block: the dialog is
  // already long, and this is the one part of it the range control does
  // not govern -- eventsFor takes a limit, not a window.
  const [showActivity, setShowActivity] = useState(false);
  const { detail, loading, error } = useStreamerDetail(
    opened && s !== null ? s.username : null,
    range,
  );
  // Once per open, not per range: the grid has its own fixed window.
  const schedule = useLiveSchedule(opened && s !== null ? s.username : null);

  if (s === null) return null;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="xl"
      classNames={{
        // On the Activity view the feed owns the scrolling, so the
        // modal itself must not also scroll -- see the CSS.
        content: showActivity ? classes.contentActivity : undefined,
        body: showActivity ? `${classes.body} ${classes.bodyActivity}` : classes.body,
      }}
      title={
        <Group gap="sm" wrap="nowrap" data-testid="detail-title">
          <StreamerAvatar
            login={s.username}
            displayName={s.displayName}
            avatarUrl={s.avatarUrl}
            size={32}
            live={s.isOnline === true}
          />
          <Text fw={600}>{s.displayName ?? s.username}</Text>
          <StatusPill
            isOnline={s.isOnline}
            liveSince={s.liveSince}
            lastLive={s.lastLive}
            elapsed={null}
          />
          {/* In the title rather than above the body: a tab bar there
              would sit over the range control while governing only one
              side of it, and would cost a row of the height this move is
              meant to give back.

              Purple when on, grey when off: the app's accent already
              means "current" on the nav, and it is the one strong colour
              in this row that is not already spoken for -- red is the
              LIVE pill, green is a gain. */}
          <Button
            variant={showActivity ? "filled" : "subtle"}
            color={showActivity ? "twitch" : "gray"}
            size="compact-xs"
            leftSection={<IconActivity size={13} stroke={2.5} />}
            onClick={() => setShowActivity((on) => !on)}
            className={classes.activityToggle}
            aria-pressed={showActivity}
            data-testid="detail-activity-toggle"
          >
            Activity
          </Button>
        </Group>
      }
    >
      {/* The flex chain has to run unbroken from the modal content down
          to the feed's ScrollArea: any link that keeps its intrinsic
          height stops the feed shrinking, and the overflow reappears as
          a second scrollbar. */}
      <Stack gap="lg" style={showActivity ? { flex: 1, minHeight: 0 } : undefined}>
        {/* The card's balance treatment, so the dialog opening over a
            card does not restate the same figure in a different hand.
            The gain beside it tracks the range control below rather
            than being pinned to 24h -- see `gained` on the fetch. */}
        <div className={classes.summary}>
          <Text className={classes.balance} data-testid="detail-balance">
            <IconCoins className={classes.coin} stroke={2} aria-hidden />
            <RollingNumber value={s.points} animate={animateBalance} />
          </Text>
          {/* Null until this range's fetch lands, which renders the em
              dash -- honest: we do not yet know the gain over this window.
              That includes a range change, where the previous range's
              figure is still in `detail` but would sit under the new
              range's label. The balance beside it comes from the
              dashboard's snapshot and is already painted. */}
          <Gain
            value={loading ? null : detail?.gained ?? null}
            label={RANGE_LABELS[range]}
            since={loading ? null : detail?.gainedSince ?? null}
            size="sm"
            testId="detail-gain"
          />
        </div>

        {/* Hidden with the history it governs: left showing over the
            feed it would offer to narrow a list it has no effect on. */}
        {!showActivity && (
          <SegmentedControl
            value={range}
            onChange={(value) => setRange(value as RangeKey)}
            data={RANGE_KEYS.map((key) => ({ value: key, label: RANGE_LABELS[key] }))}
            size="xs"
            data-testid="detail-range"
          />
        )}

        {error !== null && <Alert role="alert" color="red">{error}</Alert>}
        {/* The first load has nothing to show yet, so placeholders hold
            the chart's and the table's places; the dialog then fills in
            without jumping. */}
        {loading && detail === null && (
          <Stack
            gap="lg" role="status" aria-busy="true" aria-label="Loading history"
            data-testid="detail-loading"
          >
            <Skeleton height={240} radius="sm" />
            <Stack gap="xs">
              {[0, 1, 2].map((row) => <Skeleton key={row} height={28} radius="sm" />)}
            </Stack>
          </Stack>
        )}

        {detail !== null && showActivity && (
          /* "100%", not a computed height: the body above is a flex
             column that already stops at the modal's max-height, so the
             feed fills whatever is left after the header and balance
             line rather than guessing at their size. */
          <StreamerActivityLog events={detail.events} maxHeight="100%" fill />
        )}

        {detail !== null && !showActivity && (() => {
          const { from, to } = rangeWindow(range, Date.now());
          return (
            // A range change keeps the previous history on screen, dimmed,
            // until the new one lands -- swapping it for placeholders
            // would collapse the dialog and jump it back open.
            <Stack
              gap="lg"
              aria-busy={loading}
              data-testid="detail-history"
              style={{ opacity: loading ? 0.5 : 1, transition: "opacity 150ms ease" }}
            >
              <PointsChart
                series={detail.series}
                range={range}
                from={from}
                to={to}
                retentionFloor={detail.retentionFloor}
              />
              <StreamHistoryTable sessions={detail.sessions} />
              <CoverageTimeline
                coverage={detail.coverage}
                days={COVERAGE_DAYS[range]}
                series={detail.series}
              />
              <LiveSchedule data={schedule.data} error={schedule.error} />
            </Stack>
          );
        })()}
      </Stack>
    </Modal>
  );
}
