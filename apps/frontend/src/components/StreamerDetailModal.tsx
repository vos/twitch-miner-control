import { Alert, Group, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import { IconCoins } from "@tabler/icons-react";
import { useState } from "react";
import { useStreamerDetail } from "../api/useStreamerDetail.js";
import {
  RANGE_KEYS, RANGE_LABELS, rangeWindow, type RangeKey,
} from "../lib/detailRanges.js";
import { CoverageTimeline } from "./CoverageTimeline.js";
import { Gain } from "./Gain.js";
import { PointsChart } from "./PointsChart.js";
import { StatusPill } from "./StatusPill.js";
import { StreamerActivityLog } from "./StreamerActivityLog.js";
import { StreamerAvatar } from "./StreamerAvatar.js";
import { StreamHistoryTable } from "./StreamHistoryTable.js";
import classes from "./StreamerDetailModal.module.css";
import type { StreamerState } from "../api/useLiveState.js";

const nf = new Intl.NumberFormat("en-US");

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
export function StreamerDetailModal({ streamer, opened, onClose }: {
  streamer: StreamerState | null;
  opened: boolean;
  onClose: () => void;
}) {
  // The last streamer shown outlives the selection. The dashboard clears
  // its selection on close, and unmounting in that same render would cut
  // the exit transition and skip Mantine returning focus to the card.
  const [shown, setShown] = useState(streamer);
  if (streamer !== null && streamer !== shown) setShown(streamer);
  const s = streamer ?? shown;

  const [range, setRange] = useState<RangeKey>("7d");
  const { detail, loading, error } = useStreamerDetail(
    opened && s !== null ? s.username : null,
    range,
  );

  if (s === null) return null;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="xl"
      classNames={{ body: classes.body }}
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
        </Group>
      }
    >
      <Stack gap="lg">
        {/* The card's balance treatment, so the dialog opening over a
            card does not restate the same figure in a different hand.
            The gain beside it tracks the range control below rather
            than being pinned to 24h -- see `gained` on the fetch. */}
        <div className={classes.summary}>
          <Text className={classes.balance} data-testid="detail-balance">
            <IconCoins className={classes.coin} stroke={2} aria-hidden />
            {s.points === null ? "—" : nf.format(s.points)}
          </Text>
          {/* Null until the fetch lands, which renders the em dash --
              honest: we do not yet know the gain over this window. The
              balance beside it comes from the dashboard's snapshot and
              is already painted. */}
          <Gain
            value={detail?.gained ?? null}
            label={RANGE_LABELS[range]}
            since={detail?.gainedSince ?? null}
            size="sm"
            testId="detail-gain"
          />
        </div>

        <SegmentedControl
          value={range}
          onChange={(value) => setRange(value as RangeKey)}
          data={RANGE_KEYS.map((key) => ({ value: key, label: RANGE_LABELS[key] }))}
          size="xs"
          data-testid="detail-range"
        />

        {error !== null && <Alert role="alert" color="red">{error}</Alert>}
        {loading && <Text size="sm" c="dimmed">Loading history…</Text>}

        {detail !== null && (() => {
          const { from, to } = rangeWindow(range, Date.now());
          return (
            <>
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
              />
              {/* Last: it is the only block here that is a feed rather
                  than a summary, so it is the one a reader scrolls TO
                  rather than past. Above the coverage strip it pushed
                  the mined-vs-live comparison -- the thing no other
                  view in the app shows -- below the fold. */}
              <StreamerActivityLog events={detail.events} />
            </>
          );
        })()}
      </Stack>
    </Modal>
  );
}
