import { Card, Group, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

interface MinerEvent { ts: number; type: string }

/**
 * Events carry a type and a time and nothing else -- the miner's log
 * records have no streamer identity to forward, so rows cannot name a
 * channel.
 */
function label(type: string): string {
  return type.toLowerCase().replace(/_/g, " ");
}

function ago(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function EventsFeed() {
  const [events, setEvents] = useState<MinerEvent[] | null>(null);

  useEffect(() => {
    let alive = true;
    api.get<{ events?: MinerEvent[] }>("/api/events")
      // A 200 carrying the wrong shape is as much a failure as a rejected
      // request, and must not throw its way up into the dashboard: this
      // panel sits beside numbers that loaded fine. Mirrors the malformed
      // -frame guard in useLiveState.
      .then((payload) => {
        if (alive) setEvents(Array.isArray(payload?.events) ? payload.events : null);
      })
      // Ancillary panel: a failure here must not raise an alert next to
      // numbers that loaded fine. Stay unrendered instead.
      .catch(() => { if (alive) setEvents(null); });
    return () => { alive = false; };
  }, []);

  if (events === null) return null;

  const now = Date.now();
  return (
    <Stack gap="xs">
      <Title order={4}>Recent activity</Title>
      <Card withBorder>
        {events.length === 0 ? (
          <Text size="sm" c="dimmed">No activity yet.</Text>
        ) : (
          <Stack gap={4}>
            {events.map((event) => (
              <Group key={`${event.ts}-${event.type}`} justify="space-between">
                <Text size="sm">{label(event.type)}</Text>
                <Text size="xs" c="dimmed">{ago(event.ts, now)}</Text>
              </Group>
            ))}
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
