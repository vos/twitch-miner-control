import { Alert, Grid, Group, SimpleGrid, Stack, Switch, Text } from "@mantine/core";
import { useLiveState } from "../api/useLiveState.js";
import { EventsFeed } from "../components/EventsFeed.js";
import { StalenessBadge } from "../components/StalenessBadge.js";
import { StatTile } from "../components/StatTile.js";
import { StreamerCard } from "../components/StreamerCard.js";
import { useLocalToggle } from "../lib/useLocalToggle.js";

const nf = new Intl.NumberFormat("en-US");

function SectionHeading({ children, testId }: { children: string; testId?: string }) {
  return (
    <Group gap="sm" wrap="nowrap" mt="md">
      <Text
        size="xs" fw={700} c="dimmed" data-testid={testId}
        style={{ letterSpacing: "0.1em", whiteSpace: "nowrap" }}
      >
        {children}
      </Text>
      <div style={{ flex: 1, height: 1, background: "var(--tw-border)" }} />
    </Group>
  );
}

export function Dashboard() {
  const { snapshot, loadError } = useLiveState();
  const [feedOn, toggleFeed] = useLocalToggle("dashboard.feed", true);

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
  const live = snapshot.streamers.filter((s) => s.isOnline);
  // Streamers already shown above under "Live now" are omitted here so a
  // live streamer's points aren't rendered twice in the same view.
  const others = snapshot.streamers.filter((s) => !s.isOnline);

  // null stays null until at least one streamer has a baseline, for the
  // same reason the total does: "nothing earned" and "nothing known yet"
  // are different claims.
  const gained = snapshot.streamers.reduce<number | null>((sum, s) => {
    if (s.gained24h === null) return sum;
    return (sum ?? 0) + s.gained24h;
  }, null);

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

      <SectionHeading>{`OFFLINE · ${others.length}`}</SectionHeading>
      <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="md">
        {others.map((s) => <StreamerCard key={s.username} streamer={s} />)}
      </SimpleGrid>
    </>
  );

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <StalenessBadge lastUpdated={snapshot.lastUpdated} stale={snapshot.stale} />
        <Switch
          checked={feedOn}
          onChange={toggleFeed}
          label="Activity feed"
          size="sm"
        />
      </Group>

      {snapshot.error && <Alert role="alert" color="orange">{snapshot.error}</Alert>}

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatTile label="Total points" value={totalText} testId="total-points" />
        <StatTile label="24h gain" value={gainedText} accent="success" testId="stat-24h" />
        <StatTile label="Live now" value={String(live.length)} accent="live" testId="stat-live" />
        <StatTile
          label="Tracked" value={String(snapshot.streamers.length)} testId="stat-tracked"
        />
      </SimpleGrid>

      {/* The feed is a side column on wide screens and falls below the
          cards when there is not room for one. Grid, not a media query,
          so the reflow is a single source of truth. */}
      {feedOn ? (
        <Grid gap="md">
          <Grid.Col span={{ base: 12, lg: 8 }}>{cards}</Grid.Col>
          <Grid.Col span={{ base: 12, lg: 4 }}>
            <EventsFeed enabled={feedOn} />
          </Grid.Col>
        </Grid>
      ) : (
        cards
      )}
    </Stack>
  );
}
