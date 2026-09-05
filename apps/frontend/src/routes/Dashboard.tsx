import { Alert, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useLiveState } from "../api/useLiveState.js";
import { EventsFeed } from "../components/EventsFeed.js";
import { StalenessBadge } from "../components/StalenessBadge.js";
import { StreamerCard } from "../components/StreamerCard.js";

const nf = new Intl.NumberFormat("en-US");

export function Dashboard() {
  const { snapshot, loadError } = useLiveState();

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

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Dashboard</Title>
        <StalenessBadge lastUpdated={snapshot.lastUpdated} stale={snapshot.stale} />
      </Group>

      {snapshot.error && <Alert role="alert" color="orange">{snapshot.error}</Alert>}

      <Card withBorder>
        <Text size="sm" c="dimmed">Total channel points</Text>
        <Text size="xl" fw={700} data-testid="total-points">
          {/* A real 0 (every tracked streamer genuinely has none) and "we
              have not looked yet" must never render the same way -- the
              latter used to show a confident "0" for a full refresh
              interval after every restart, beside a badge nobody reads
              closely enough to notice contradicts it. */}
          {snapshot.lastUpdated === null ? "—" : nf.format(total)}
        </Text>
      </Card>

      <Title order={4} data-testid="live-heading">Live now ({live.length})</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {live.map((s) => <StreamerCard key={s.username} streamer={s} />)}
      </SimpleGrid>

      <Title order={4}>Offline</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {others.map((s) => <StreamerCard key={s.username} streamer={s} />)}
      </SimpleGrid>

      <EventsFeed />
    </Stack>
  );
}
