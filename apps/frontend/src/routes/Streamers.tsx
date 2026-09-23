import { ActionIcon, Alert, Group, Stack, Text, Title, Tooltip } from "@mantine/core";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter,
  type DragEndEvent, useSensor, useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { IconRefresh } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client.js";
import { AddStreamer } from "../components/AddStreamer.js";
import type { Stamped } from "../lib/screenIntent.js";
import { StreamerSettingsModal } from "../components/StreamerSettingsModal.js";
import { PendingBar } from "../components/PendingBar.js";
import { StreamerRow } from "../components/StreamerRow.js";

interface StreamerEntry {
  username: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  /**
   * The id of the drop subscription that added this channel, when one
   * did. Absent on a hand-added streamer.
   *
   * Read but never written here: the whole config object round-trips
   * through the draft, so the field survives an Apply untouched, and the
   * engine stays the only thing that sets it.
   */
  ownedBy?: string;
}
/** The subscriptions, so an owned row can name the campaign it came from. */
interface SubscriptionEntry { id: string; label: string; game?: string | null }
/**
 * The slice of the live snapshot this screen reads.
 *
 * Every field is optional-by-nullability: a backend that predates them,
 * or a frame that drops one, must degrade to a row without a pill rather
 * than take the config screen down.
 */
interface StreamerStatus {
  username: string;
  avatarUrl: string | null;
  isOnline: boolean | null;
  liveSince: number | null;
  lastLive: number | null;
  /** Observed by the backend from watch-point gains; see StreamerRow. */
  watching?: boolean;
}
interface Config {
  version: 1; username: string; followers: boolean; followersOrder: string;
  defaults: Record<string, unknown>; streamers: StreamerEntry[];
}

export function Streamers({ prefill = null }: {
  /** Text the command palette wants in the add box. */
  prefill?: Stamped<string> | null;
} = {}) {
  const [saved, setSaved] = useState<Config | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<Map<string, StreamerStatus>>(new Map());
  /** Subscription id to campaign label, for the badge on owned rows. */
  const [campaigns, setCampaigns] = useState<Map<string, SubscriptionEntry>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  /** Index of the streamer whose settings dialog is open, if any. */
  const [editing, setEditing] = useState<number | null>(null);

  // An activation distance keeps a click on the grip from being read as a
  // drag; the keyboard sensor is the only reorder path for a keyboard user
  // now that the move-up arrow is gone.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * Pictures and live state. A failure here must not touch `loadError` --
   * the config screen has to work with the miner stopped, which is exactly
   * when someone is most likely to be on it. It leaves `status` empty, and
   * a row with no entry renders no pill rather than claiming "offline".
   *
   * Only ever writes `status`, never `draft`: a refresh must not discard
   * an order the user has staged but not applied.
   */
  const loadStatus = useCallback(async () => {
    setRefreshing(true);
    try {
      // A pending snapshot is adopted like any other: its rows carry the
      // stored state these pills read, and `isOnline: null` renders no
      // pill rather than a wrong one.
      const snapshot = await api.get<{ streamers: StreamerStatus[] }>("/api/streamers");
      setStatus(new Map(
        snapshot.streamers.map((s) => [s.username.toLowerCase(), s]),
      ));
    } catch {
      // Decoration only -- leave whatever we last knew on screen.
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Re-runs on every visit: app.tsx swaps the screen element, so this
  // component remounts and the status is fresh each time you arrive.
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  useEffect(() => {
    api.get<Config>("/api/config")
      .then((c) => { setSaved(c); setDraft(c); })
      .catch((cause) => {
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  // Decoration, like the live status above: a failure here must not touch
  // `loadError`. An owned row whose label is missing still renders as
  // owned -- locked, with a generic badge -- because `ownedBy` alone is
  // what makes it owned. Losing the name is worth less than wrongly
  // offering controls that do not work.
  useEffect(() => {
    api.get<{ subscriptions: SubscriptionEntry[] }>("/api/subscriptions")
      .then(({ subscriptions }) => {
        setCampaigns(new Map(subscriptions.map((sub) => [sub.id, sub])));
      })
      .catch(() => {});
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

  const remove = (index: number) => {
    setError(null);
    setDraft({ ...draft, streamers: draft.streamers.filter((_, i) => i !== index) });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    // No `over` means the drag was cancelled or released outside the list.
    if (!over || active.id === over.id) return;
    // Reordered within the hand-added rows alone, then spliced back into
    // their original slots. A plain arrayMove over the mixed list would
    // drag every owned row between the two positions along with it, and
    // the engine writes those in its own rank order -- so the shuffle
    // would show as a pending change and then be undone by the next pass.
    const manual = draft.streamers.filter((s) => s.ownedBy === undefined);
    const from = manual.findIndex((s) => s.username === active.id);
    const to = manual.findIndex((s) => s.username === over.id);
    if (from === -1 || to === -1) return;
    const moved = arrayMove(manual, from, to);
    let next = 0;
    setDraft({
      ...draft,
      streamers: draft.streamers.map(
        (s) => (s.ownedBy === undefined ? moved[next++]! : s),
      ),
    });
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
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" c="dimmed">
          The miner mines two channels at a time, choosing them from the
          streamers that are live with channel points enabled — so an offline
          or points-disabled channel is skipped and the next eligible one
          takes the slot. Order below is your priority, but a pending watch
          streak or drop can jump the queue. The “watching” tag marks what is
          actually being mined right now.
        </Text>
          {/* Refreshes the live snapshot without touching the staged draft. */}
          <Tooltip label="Refresh live status">
            <ActionIcon
              variant="subtle" color="gray"
              aria-label="Refresh live status"
              onClick={() => void loadStatus()} loading={refreshing}
            >
              <IconRefresh size={16} />
            </ActionIcon>
          </Tooltip>
      </Group>
      {error && <Alert role="alert" color="red">{error}</Alert>}
      {/* Keyed to the navigation, so each prefill remounts the box with
          its own text and a plain visit gets an empty one. */}
      <AddStreamer
        key={prefill?.id ?? 0}
        onAdd={add}
        initialValue={prefill?.value}
        autoFocus={prefill !== null}
      />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={draft.streamers.filter((s) => s.ownedBy === undefined)
            .map((s) => s.username)}
          strategy={verticalListSortingStrategy}
        >
          <Stack gap={6}>
            {draft.streamers.map((streamer, index) => (
              <StreamerRow
                key={streamer.username}
                username={streamer.username}
                enabled={streamer.enabled}
                status={status.get(streamer.username.toLowerCase()) ?? null}
                index={index}
                watching={status.get(streamer.username.toLowerCase())?.watching === true}
                ownedByLabel={labelFor(streamer, campaigns)}
                ownedByGame={gameFor(streamer, campaigns)}
                onToggle={() => toggle(index)}
                onRemove={() => remove(index)}
                onOpenSettings={() => setEditing(index)}
              />
            ))}
          </Stack>
        </SortableContext>
      </DndContext>
      {editing !== null && draft.streamers[editing] && (
        <StreamerSettingsModal
          opened
          username={draft.streamers[editing].username}
          settings={draft.streamers[editing].settings}
          defaults={draft.defaults}
          onClose={() => setEditing(null)}
          onChange={(settings) => setDraft({
            ...draft,
            streamers: draft.streamers.map((s, i) =>
              i === editing ? { ...s, settings } : s),
          })}
        />
      )}
      <PendingBar count={changes} onApply={() => void apply()} busy={busy} />
    </Stack>
  );
}

/**
 * What to show on a row's campaign badge: the campaign name, a generic
 * stand-in when the subscription list did not load, or null for a
 * hand-added streamer.
 *
 * The fallback matters because the label is decoration but the lock is
 * not -- see the fetch above.
 */
function labelFor(
  streamer: StreamerEntry,
  campaigns: Map<string, SubscriptionEntry>,
): string | null {
  if (streamer.ownedBy === undefined) return null;
  return campaigns.get(streamer.ownedBy)?.label ?? "drop campaign";
}

/**
 * The game the owning subscription is for, or null when unknown.
 *
 * What the row's badge shows; see StreamerRow for why the game leads
 * and the campaign label is only the fallback.
 */
function gameFor(
  streamer: StreamerEntry,
  campaigns: Map<string, SubscriptionEntry>,
): string | null {
  if (streamer.ownedBy === undefined) return null;
  return campaigns.get(streamer.ownedBy)?.game ?? null;
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
