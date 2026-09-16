import { AreaChart, BarChart } from "@mantine/charts";
import { Group, SegmentedControl, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { bucketPoints, type PointSample } from "../lib/bucketPoints.js";
import type { RangeKey } from "../lib/detailRanges.js";

const nf = new Intl.NumberFormat("en-US");

/** Mantine sizes the chart's ResponsiveContainer from this. Under jsdom
 *  that container measures 0x0 and draws an empty SVG, which is why the
 *  tests assert on the surrounding DOM and on bucketPoints, never on the
 *  chart's own markup. */
const CHART_HEIGHT = 240;

/** Precise to the bucket: 7d buckets are six hours wide, so a date alone
 *  labels four neighbouring points identically. */
const LABEL: Record<RangeKey, Intl.DateTimeFormatOptions> = {
  "24h": { hour: "numeric", minute: "2-digit" },
  "7d": { month: "short", day: "numeric", hour: "numeric" },
  "30d": { month: "short", day: "numeric" },
  all: { month: "short", day: "numeric" },
};

const dateLabel = (ts: number, range: RangeKey) =>
  new Date(ts).toLocaleString(undefined, LABEL[range]);

/**
 * One channel's balance over time, and the gains that moved it.
 *
 * Two views over one series. The balance answers "where am I", but it is
 * nearly flat at most zooms -- a channel earning steadily draws a line
 * that barely leaves its own axis. The gain view differences it, which is
 * where the answer to "when was this channel actually earning" lives.
 *
 * The area chart steps rather than slopes, and steps *after* each point:
 * point writes are change-only, so a balance holds until the next sample
 * and jumps there. A curve through the gap would claim gradual earning
 * across a stretch where nothing happened; a centred step would move the
 * jump half a bucket early.
 */
export function PointsChart({ series, range, from, to, retentionFloor }: {
  series: PointSample[];
  range: RangeKey;
  from: number;
  to: number;
  retentionFloor: number | null;
}) {
  const [view, setView] = useState<"balance" | "gain">("balance");
  const rows = bucketPoints(series, range, from, to);

  if (rows.length === 0) {
    return (
      <Text size="sm" c="dimmed" data-testid="points-chart-empty">
        No points history in this window yet.
      </Text>
    );
  }

  const data = rows.map((row) => ({
    label: dateLabel(row.ts, range),
    Balance: row.balance,
    Gain: row.gain,
  }));

  return (
    <Stack gap="xs">
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em" }}>
          POINTS
        </Text>
        <SegmentedControl
          value={view}
          onChange={(value) => setView(value as "balance" | "gain")}
          data={[{ value: "balance", label: "Balance" }, { value: "gain", label: "Gain" }]}
          size="xs"
          data-testid="points-chart-view"
        />
      </Group>

      <div data-testid="points-chart">
        {view === "balance" ? (
          <AreaChart
            h={CHART_HEIGHT}
            data={data}
            dataKey="label"
            series={[{ name: "Balance", color: "teal.6" }]}
            curveType="stepAfter"
            withDots={false}
            valueFormatter={(value) => nf.format(value)}
          />
        ) : (
          <BarChart
            h={CHART_HEIGHT}
            data={data}
            dataKey="label"
            series={[{ name: "Gain", color: "teal.6" }]}
            valueFormatter={(value) => nf.format(value)}
          />
        )}
      </div>

      {range === "all" && retentionFloor !== null && (
        <Text size="xs" c="dimmed" data-testid="retention-note">
          {/* Policy, not a claim that pruning happened: a channel added
              last week has lost nothing, and its oldest sample is simply
              the first one. */}
          Earliest sample on record: {new Date(retentionFloor).toLocaleDateString(undefined,
            { month: "short", day: "numeric", year: "numeric" })}.
          Older point history is pruned.
        </Text>
      )}
    </Stack>
  );
}
