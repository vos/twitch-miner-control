import { Alert, Group, Modal, SegmentedControl, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useStreamerDetail } from "../api/useStreamerDetail.js";
import {
  RANGE_KEYS, RANGE_LABELS, rangeWindow, type RangeKey,
} from "../lib/detailRanges.js";
import { CoverageTimeline } from "./CoverageTimeline.js";
import { PointsChart } from "./PointsChart.js";
import { StatusPill } from "./StatusPill.js";
import { StreamerActivityLog } from "./StreamerActivityLog.js";
import { StreamerAvatar } from "./StreamerAvatar.js";
import { StreamHistoryTable } from "./StreamHistoryTable.js";
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
        <Group gap="lg" wrap="wrap">
          <Text size="sm" data-testid="detail-balance">
            {s.points === null ? "—" : nf.format(s.points)} points
          </Text>
          <Text size="sm" c="dimmed">
            {s.gained24h === null
              ? "— 24h"
              : `${s.gained24h > 0 ? "+" : ""}${nf.format(s.gained24h)} 24h`}
          </Text>
        </Group>

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
              <StreamerActivityLog events={detail.events} />
              <CoverageTimeline
                coverage={detail.coverage}
                days={COVERAGE_DAYS[range]}
              />
            </>
          );
        })()}
      </Stack>
    </Modal>
  );
}
