import {
  ActionIcon, Alert, Badge, Card, Group, Stack, Switch, Text, Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { AddStreamer } from "../components/AddStreamer.js";
import { PendingBar } from "../components/PendingBar.js";

interface StreamerEntry {
  username: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}
interface Config {
  version: 1; username: string; followers: boolean; followersOrder: string;
  defaults: Record<string, unknown>; streamers: StreamerEntry[];
}

export function Streamers() {
  const [saved, setSaved] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Config>("/api/config")
      .then((c) => { setSaved(c); setDraft(c); })
      .catch((cause) => {
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  if (loadError) {
    return (
      <Alert role="alert" color="red">
        Failed to load streamers: {loadError}
      </Alert>
    );
  }

  if (!draft || !saved) return null;

  const changes = countChanges(saved.streamers, draft.streamers);

  const add = async (username: string) => {
    setError(null);
    if (draft.streamers.some((s) => s.username.toLowerCase() === username.toLowerCase())) {
      setError(`${username} is already in the list`);
      return;
    }
    try {
      const found = await api.get<{ exists: boolean }>(
        `/api/streamers/lookup?q=${encodeURIComponent(username)}`,
      );
      if (!found.exists) {
        setError(`No such Twitch user: ${username}`);
        return;
      }
      setDraft({
        ...draft,
        streamers: [...draft.streamers, { username, enabled: true, settings: {} }],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const toggle = (index: number) => {
    const streamers = draft.streamers.map((s, i) =>
      i === index ? { ...s, enabled: !s.enabled } : s,
    );
    setDraft({ ...draft, streamers });
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    const streamers = [...draft.streamers];
    [streamers[index - 1], streamers[index]] = [streamers[index], streamers[index - 1]];
    setDraft({ ...draft, streamers });
  };

  const moveTo = (from: number, to: number) => {
    if (from === to) return;
    const streamers = [...draft.streamers];
    const [moved] = streamers.splice(from, 1);
    streamers.splice(to, 0, moved);
    setDraft({ ...draft, streamers });
  };

  const apply = async () => {
    setBusy(true);
    try {
      await api.put("/api/config", draft);
      await api.post("/api/config/apply");
      setSaved(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack pb={80}>
      <Title order={2}>Streamers</Title>
      <Text size="sm" c="dimmed">Order is priority — the miner watches the top two.</Text>
      {error && <Alert role="alert" color="red">{error}</Alert>}
      <AddStreamer onAdd={add} />
      <Stack gap={6}>
        {draft.streamers.map((streamer, index) => (
          <Card
            withBorder
            key={streamer.username}
            data-testid="streamer-row"
            padding="sm"
            draggable
            onDragStart={(e) => e.dataTransfer.setData("text/plain", String(index))}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              moveTo(Number(e.dataTransfer.getData("text/plain")), index);
            }}
            style={index < 2
              ? { background: "rgba(145,71,255,0.08)", borderColor: "var(--tw-purple)" }
              : undefined}
          >
            <Group justify="space-between" wrap="nowrap">
              <Group gap="sm" wrap="nowrap">
                {/* The arrow stays: drag is mouse-only, and this is the
                    keyboard-accessible path. */}
                <ActionIcon
                  variant="subtle" aria-label="Move up"
                  onClick={() => moveUp(index)} disabled={index === 0}
                >
                  ↑
                </ActionIcon>
                <Text size="sm" c="dimmed" ff="monospace" w={20}>{index + 1}</Text>
                <Text fw={500}>{streamer.username}</Text>
                {index < 2 && (
                  <Badge size="xs" variant="light" color="twitch" data-testid="watching-tag">
                    watching
                  </Badge>
                )}
              </Group>
              <Switch
                checked={streamer.enabled}
                onChange={() => toggle(index)}
                aria-label={`Enable ${streamer.username}`}
              />
            </Group>
          </Card>
        ))}
      </Stack>
      <PendingBar count={changes} onApply={() => void apply()} busy={busy} />
    </Stack>
  );
}

function countChanges(before: StreamerEntry[], after: StreamerEntry[]): number {
  if (JSON.stringify(before) === JSON.stringify(after)) return 0;
  const names = new Set([...before, ...after].map((s) => s.username));
  let count = 0;
  for (const name of names) {
    const a = before.find((s) => s.username === name);
    const b = after.find((s) => s.username === name);
    if (JSON.stringify(a) !== JSON.stringify(b)) count += 1;
  }
  const orderChanged =
    before.map((s) => s.username).join() !== after.map((s) => s.username).join();
  return count === 0 && orderChanged ? 1 : count;
}
