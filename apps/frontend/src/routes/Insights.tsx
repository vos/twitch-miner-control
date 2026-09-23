import {
  ActionIcon, Alert, Button, Group, SegmentedControl, Stack, Text,
} from "@mantine/core";
import { IconChevronLeft, IconChevronRight, IconDownload } from "@tabler/icons-react";
import { useRef, useState } from "react";
import { useCalendar, useRecap, type PeriodKind } from "../api/useInsights.js";
import { InsightsCalendar } from "../components/InsightsCalendar.js";
import { RecapCard } from "../components/RecapCard.js";
import { exportPng } from "../lib/exportPng.js";
import { recapFilename, weekOffsetOf } from "../lib/insightsFormat.js";
import type { Stamped } from "../lib/screenIntent.js";

const nf = new Intl.NumberFormat("en-US");

/** A section rule, as the dashboard draws them. */
function Rule({ children }: { children: string }) {
  return (
    <Group gap="sm" wrap="nowrap">
      <Text size="xs" fw={700} c="dimmed" style={{ letterSpacing: "0.1em", whiteSpace: "nowrap" }}>
        {children}
      </Text>
      <div style={{ flex: 1, height: 1, background: "var(--tw-border)" }} />
    </Group>
  );
}

export function Insights({ period = null }: {
  /** A recap the command palette wants opened. */
  period?: Stamped<PeriodKind> | null;
} = {}) {
  const [kind, setKind] = useState<PeriodKind>(period?.value ?? "week");
  const [offset, setOffset] = useState(0);
  // Applied once per palette jump, however often this renders.
  const [appliedJump, setAppliedJump] = useState<number | null>(period?.id ?? null);
  if (period !== null && period.id !== appliedJump) {
    setAppliedJump(period.id);
    setKind(period.value);
    setOffset(0);
  }

  const calendar = useCalendar();
  const recap = useRecap(kind, offset);
  const card = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const onExport = async () => {
    if (card.current === null || recap.data === null) return;
    setExporting(true);
    setExportError(null);
    try {
      await exportPng(card.current, recapFilename(recap.data.period));
    } catch (cause) {
      setExportError(`Export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setExporting(false);
    }
  };

  const year = calendar.data?.days.reduce((sum, d) => sum + d.earned, 0) ?? 0;

  return (
    <Stack gap="lg">
      {calendar.error !== null && (
        <Alert role="alert" color="red">Failed to load the calendar: {calendar.error}</Alert>
      )}

      {calendar.data !== null && (calendar.data.since === null ? (
        <Text c="dimmed" data-testid="insights-empty">
          Not enough history yet. Insights fill in as the miner runs.
        </Text>
      ) : (
        <Stack gap="sm">
          <Text size="sm" data-testid="insights-streak">
            {`🔥 ${calendar.data.streak.current}-day streak · longest ${calendar.data.streak.longest}`}
            <Text span c="dimmed">{`   ${nf.format(year)} earned in the last year`}</Text>
          </Text>
          <InsightsCalendar
            calendar={calendar.data}
            onPickDay={(date) => {
              setKind("week");
              setOffset(weekOffsetOf(date, Date.now()));
            }}
          />
        </Stack>
      ))}

      <Rule>RECAP</Rule>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <SegmentedControl
          size="xs"
          value={kind}
          onChange={(value) => { setKind(value as PeriodKind); setOffset(0); }}
          data={[{ value: "week", label: "Week" }, { value: "month", label: "Month" }]}
          data-testid="recap-period"
        />
        <Group gap="xs">
          <ActionIcon
            variant="default" aria-label="Previous period" data-testid="recap-prev"
            onClick={() => setOffset((o) => o - 1)}
          >
            <IconChevronLeft size={16} />
          </ActionIcon>
          <ActionIcon
            variant="default" aria-label="Next period" data-testid="recap-next"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.min(0, o + 1))}
          >
            <IconChevronRight size={16} />
          </ActionIcon>
        </Group>
      </Group>

      {recap.error !== null && (
        <Alert role="alert" color="red">Failed to load the recap: {recap.error}</Alert>
      )}
      {recap.data !== null && (
        <Group align="flex-start" gap="md">
          {/* The card is 600px wide by design; on a narrow screen it
              scrolls rather than reflowing, so the export stays the same. */}
          <div style={{ maxWidth: "100%", overflowX: "auto" }}>
            <RecapCard recap={recap.data} ref={card} />
          </div>
          <Stack gap={4}>
            <Button
              variant="default" size="xs" leftSection={<IconDownload size={14} />}
              loading={exporting} onClick={() => void onExport()}
              data-testid="recap-export"
            >
              PNG
            </Button>
            {exportError !== null && (
              <Text size="xs" c="red" role="alert" data-testid="recap-export-error">
                {exportError}
              </Text>
            )}
          </Stack>
        </Group>
      )}
    </Stack>
  );
}
