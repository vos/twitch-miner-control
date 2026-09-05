import { Card, Group, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

interface MinerEvent { ts: number; type: string; message: string | null }

/**
 * Rows render the miner's own formatted line, which already names the
 * streamer and reads the way its log does ("+50 -> forsen"). `message` is
 * null only for rows stored before the doorbell forwarded one, so those
 * fall back to the bare event name.
 */
function label(event: MinerEvent): string {
  return event.message ?? event.type.toLowerCase().replace(/_/g, " ");
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
    const load = () =>
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
    void load();
    // Events arrive on the miner's schedule, not the viewer's. Without a
    // poll the feed showed whatever was true when the page mounted and
    // then silently aged, which is what makes a log look dead. Matches the
    // Logs route's interval.
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
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
          <Stack gap={6}>
            {events.map((event) => (
              <Group
                key={`${event.ts}-${event.type}`}
                justify="space-between"
                wrap="nowrap"
                gap="md"
                align="baseline"
              >
                {/* Monospace, matching the Logs route: these are the
                    miner's own lines, and its columns line up when the
                    glyphs do. `truncate` keeps a long recap on one row
                    instead of reflowing the feed. */}
                <Text size="sm" ff="monospace" truncate>
                  {label(event)}
                </Text>
                <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  {ago(event.ts, now)}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
