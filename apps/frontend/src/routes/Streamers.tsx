import { Alert, Stack, Text, Title } from "@mantine/core";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter,
  type DragEndEvent, useSensor, useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { AddStreamer } from "../components/AddStreamer.js";
import { PendingBar } from "../components/PendingBar.js";
import { StreamerRow } from "../components/StreamerRow.js";

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

  const [avatars, setAvatars] = useState<Map<string, string | null>>(new Map());

  // An activation distance keeps a click on the grip from being read as a
  // drag; the keyboard sensor is the only reorder path for a keyboard user
  // now that the move-up arrow is gone.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    // Pictures only. A failure here must not touch `loadError` -- the
    // config screen has to work with the miner stopped, which is exactly
    // when someone is most likely to be on it.
    api.get<{ streamers: { username: string; avatarUrl: string | null }[] }>(
      "/api/streamers",
    )
      .then((snapshot) => {
        setAvatars(new Map(
          snapshot.streamers.map((s) => [s.username.toLowerCase(), s.avatarUrl]),
        ));
      })
      .catch(() => {});
  }, []);

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

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    // No `over` means the drag was cancelled or released outside the list.
    if (!over || active.id === over.id) return;
    const from = draft.streamers.findIndex((s) => s.username === active.id);
    const to = draft.streamers.findIndex((s) => s.username === over.id);
    if (from === -1 || to === -1) return;
    setDraft({ ...draft, streamers: arrayMove(draft.streamers, from, to) });
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
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={draft.streamers.map((s) => s.username)}
          strategy={verticalListSortingStrategy}
        >
          <Stack gap={6}>
            {draft.streamers.map((streamer, index) => (
              <StreamerRow
                key={streamer.username}
                username={streamer.username}
                enabled={streamer.enabled}
                avatarUrl={avatars.get(streamer.username.toLowerCase()) ?? null}
                index={index}
                watching={index < 2}
                onToggle={() => toggle(index)}
              />
            ))}
          </Stack>
        </SortableContext>
      </DndContext>
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
