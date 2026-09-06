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

/** Matches the server's /api/events page size, so the panel stays bounded. */
const MAX_ROWS = 20;

export function EventsFeed({ enabled }: { enabled: boolean }) {
  const [events, setEvents] = useState<MinerEvent[] | null>(null);

  useEffect(() => {
    // Switching the feed off must stop the traffic, not just hide the
    // panel: this effect owns the only /api/events caller in the app, and
    // its own EventSource.
    if (!enabled) {
      setEvents(null);
      return;
    }
    let alive = true;
    // One request, for the backlog that predates this mount. Everything
    // after it arrives on the stream, so the feed no longer re-downloads
    // rows it already has every few seconds.
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

    // A second EventSource alongside useLiveState's: the browser's per-host
    // connection budget is spent either way, and coupling this panel's
    // lifecycle to the dashboard-wide hook would mean the stream could not
    // be switched off with the feed. Reconnection is left to EventSource
    // itself -- a missed row here costs a log line until the next mount,
    // not a wrong number, so it does not need useLiveState's auth probe.
    const source = new EventSource("/api/stream");
    source.addEventListener("event", (frame) => {
      let row: MinerEvent;
      try {
        row = JSON.parse((frame as MessageEvent).data) as MinerEvent;
      } catch {
        // A malformed frame must never take the page down.
        return;
      }
      if (!alive) return;
      // Newest first, matching the route's ordering, and capped so a
      // long-lived tab cannot grow the list without bound. A backlog that
      // failed to load stays null rather than being resurrected by a
      // pushed row into a misleading one-row "history".
      setEvents((current) => (current === null ? null : [row, ...current].slice(0, MAX_ROWS)));
    });

    return () => {
      alive = false;
      source.close();
    };
  }, [enabled]);

  if (!enabled) return null;
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
