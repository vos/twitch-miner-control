import { Alert, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useLiveState } from "../api/useLiveState.js";
import { StalenessBadge } from "../components/StalenessBadge.js";

const nf = new Intl.NumberFormat("en-US");
const fmt = (points: number | null) => (points === null ? "—" : nf.format(points));

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

      <Title order={4}>Live now ({live.length})</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {live.map((s) => (
          <Card withBorder key={s.username} data-testid={`live-${s.username}`}>
            <Text fw={600}>{s.displayName ?? s.username}</Text>
            <Text size="lg">{fmt(s.points)}</Text>
          </Card>
        ))}
      </SimpleGrid>

      <Title order={4}>Offline</Title>
      <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }}>
        {others.map((s) => (
          <Card withBorder key={s.username}>
            <Group justify="space-between">
              <Text fw={500}>{s.displayName ?? s.username}</Text>
              <Text c={s.isOnline ? "green" : "dimmed"} size="sm">
                {s.isOnline === null ? "unknown" : s.isOnline ? "live" : "offline"}
              </Text>
            </Group>
            <Text size="lg">{fmt(s.points)}</Text>
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
}
