import { Alert, Group, NativeSelect, SimpleGrid, Stack, Switch, Text, UnstyledButton } from "@mantine/core";
import { useLiveState } from "../api/useLiveState.js";
import { EventsFeed } from "../components/EventsFeed.js";
import { StalenessBadge } from "../components/StalenessBadge.js";
import { StatTile } from "../components/StatTile.js";
import { StreamerCard } from "../components/StreamerCard.js";
import { SORT_KEYS, SORT_LABELS, sortStreamers, type SortKey } from "../lib/sortStreamers.js";
import { useLocalChoice } from "../lib/useLocalChoice.js";
import { useLocalToggle } from "../lib/useLocalToggle.js";

const nf = new Intl.NumberFormat("en-US");

/**
 * A section rule.
 *
 * `mb` is deliberately larger than the Stack's own gap: a heading sitting
 * the same distance from its cards as from the section above reads as
 * crowded and does not group with what it labels.
 *
 * Passing `collapsed` turns the whole rule into the section's disclosure
 * control. The heading already carries the count, so a collapsed section
 * still reports how many streamers it holds -- no separate "12 hidden"
 * label, and no risk of an empty section reading as an empty roster.
 */
function SectionHeading({ children, testId, collapsed, onToggle }: {
  children: string;
  testId?: string;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const label = (
    <>
      <Text
        size="xs" fw={700} c="dimmed"
        style={{ letterSpacing: "0.1em", whiteSpace: "nowrap" }}
      >
        {children}
      </Text>
      <div style={{ flex: 1, height: 1, background: "var(--tw-border)" }} />
    </>
  );

  if (!onToggle) {
    return (
      <Group gap="sm" wrap="nowrap" mt="xl" mb="xs" data-testid={testId}>
        {label}
      </Group>
    );
  }

  return (
    <UnstyledButton
      onClick={onToggle}
      data-testid={testId}
      aria-expanded={!collapsed}
      mt="xl" mb="xs"
      style={{ display: "block", width: "100%" }}
    >
      <Group gap="sm" wrap="nowrap">
        {/* A caret rather than a chevron icon: the app pulls in no icon
            set, and a rotated glyph costs nothing to ship. */}
        <Text
          size="xs" c="dimmed" aria-hidden
          style={{
            display: "inline-block",
            transition: "transform 150ms ease",
            transform: collapsed ? "rotate(-90deg)" : "none",
          }}
        >
          ▾
        </Text>
        {label}
      </Group>
    </UnstyledButton>
  );
}

export function Dashboard() {
  const { snapshot, loadError } = useLiveState();
  const [feedOn, toggleFeed] = useLocalToggle("dashboard.feed", true);
  // Offline streamers are the bulk of a big roster and the least
  // interesting part of it, so they start shown but collapse away.
  const [offlineOn, toggleOffline] = useLocalToggle("dashboard.offline", true);
  // One choice drives both sections. Per-section controls would have to
  // live in the headings, and the offline heading is already a button --
  // nesting a menu inside it is both an a11y problem and an easy misclick.
  const [sort, setSort] = useLocalChoice<SortKey>("dashboard.sort", "default", SORT_KEYS);

  if (!snapshot) {
    if (loadError) {
      return (
        <Alert role="alert" color="red">
          Failed to load dashboard: {loadError}
        </Alert>
      );
    }
    return null;
  }

  const total = snapshot.streamers.reduce((sum, s) => sum + (s.points ?? 0), 0);
  // Sorted after the split, not before: "recently live" reads a different
  // field on each side (a live channel has no lastLive, an offline one no
  // liveSince), and the grouping is the dashboard's primary claim anyway.
  const live = sortStreamers(snapshot.streamers.filter((s) => s.isOnline), sort, "live");
  // Streamers already shown above under "Live now" are omitted here so a
  // live streamer's points aren't rendered twice in the same view.
  const others = sortStreamers(
    snapshot.streamers.filter((s) => !s.isOnline), sort, "offline",
  );

  // null stays null until at least one streamer has a baseline, for the
  // same reason the total does: "nothing earned" and "nothing known yet"
  // are different claims.
  const gained = snapshot.streamers.reduce<number | null>((sum, s) => {
    if (s.gained24h === null) return sum;
    return (sum ?? 0) + s.gained24h;
  }, null);

  // A streamer tracked for two hours contributes a two-hour gain to a
  // figure labelled "24h". That is worth showing -- it is real earning --
  // but the tile must say so, or the sum quietly overstates its window.
  const partial = snapshot.streamers.some(
    (s) => s.gained24h !== null && s.gainedSince !== null,
  );

  // A real 0 (every tracked streamer genuinely has none) and "we have not
  // looked yet" must never render the same way -- the latter used to show
  // a confident "0" for a full refresh interval after every restart,
  // beside a badge nobody reads closely enough to notice contradicts it.
  const totalText = snapshot.lastUpdated === null ? "—" : nf.format(total);
  const gainedText = gained === null
    ? "—"
    : `${gained > 0 ? "+" : ""}${nf.format(gained)}`;

  const cards = (
    <>
      <SectionHeading testId="live-heading">{`LIVE NOW · ${live.length}`}</SectionHeading>
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="md">
        {live.map((s) => <StreamerCard key={s.username} streamer={s} />)}
      </SimpleGrid>

      <SectionHeading
        testId="offline-heading"
        collapsed={!offlineOn}
        onToggle={toggleOffline}
      >
        {`OFFLINE · ${others.length}`}
      </SectionHeading>
      {offlineOn && (
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="md">
          {others.map((s) => <StreamerCard key={s.username} streamer={s} />)}
        </SimpleGrid>
      )}
    </>
  );

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <StalenessBadge lastUpdated={snapshot.lastUpdated} stale={snapshot.stale} />
        <Group gap="md" wrap="nowrap">
          {/* A native <select> rather than Mantine's Select: four fixed
              options need no search or portal, and it is the better
              control on a phone and by keyboard. Mantine's Combobox also
              renders enough inline CSS to stall vitest's reporter channel
              in CI, which made the whole test file look hung. */}
          <NativeSelect
            data={SORT_KEYS.map((key) => ({ value: key, label: SORT_LABELS[key] }))}
            value={sort}
            onChange={(event) => setSort(event.currentTarget.value as SortKey)}
            aria-label="Sort streamers"
            data-testid="sort-control"
            size="xs"
            w={150}
          />
          <Switch
            checked={feedOn}
            onChange={toggleFeed}
            label="Activity feed"
            size="sm"
          />
        </Group>
      </Group>

      {snapshot.error && <Alert role="alert" color="orange">{snapshot.error}</Alert>}

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatTile label="Total points" value={totalText} testId="total-points" />
        <StatTile
          label="24h gain"
          value={gainedText}
          hint={partial && gained !== null ? "partial · some tracked <24h" : undefined}
          accent="success"
          testId="stat-24h"
        />
        <StatTile label="Live now" value={String(live.length)} accent="live" testId="stat-live" />
        <StatTile
          label="Tracked" value={String(snapshot.streamers.length)} testId="stat-tracked"
        />
      </SimpleGrid>

      {cards}

      {/* Full width beneath the cards rather than a side column: the
          miner's own log lines are long, and a narrow column truncated
          almost every one of them. */}
      <EventsFeed enabled={feedOn} />
    </Stack>
  );
}
