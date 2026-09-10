import { ActionIcon, Badge, Card, Group, Switch, Text } from "@mantine/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconGripVertical, IconX } from "@tabler/icons-react";
import { StatusPill } from "./StatusPill.js";
import { StreamerAvatar } from "./StreamerAvatar.js";

/** What the live snapshot knows about this channel; null when unreachable. */
export interface RowStatus {
  avatarUrl: string | null;
  isOnline: boolean | null;
  liveSince: number | null;
  lastLive: number | null;
  /**
   * Whether the miner is actually watching this channel, as observed by
   * the backend from watch-point gains. Absent on a snapshot from a
   * backend that predates the field, which reads as "not watching" --
   * no badge, rather than a guess.
   */
  watching?: boolean;
}

interface Props {
  username: string;
  enabled: boolean;
  status: RowStatus | null;
  /** 0-based position, shown as the priority number and drives the tint. */
  index: number;
  /**
   * Whether the miner is observed to be watching this channel right now.
   *
   * Not a function of position: the miner fills its two watch slots from
   * the channels that are live with points enabled, and a pending watch
   * streak or drop can promote one over a higher-priority channel. This
   * reports what is happening, so it is legitimately empty when nothing
   * is being mined -- the miner stopped, everyone offline, or a slot not
   * yet confirmed by a first watch gain.
   */
  watching: boolean;
  onToggle: () => void;
  onRemove: () => void;
}

/**
 * One draggable row of the streamer priority list.
 *
 * The drag listeners sit on the grip, not the card: the row also holds a
 * channel link (natively draggable) and a switch, and a whole-card handle
 * makes those fight the reorder.
 */
export function StreamerRow(
  { username, enabled, status, index, watching, onToggle, onRemove }: Props,
) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform,
    transition, isDragging,
  } = useSortable({ id: username });

  return (
    <Card
      withBorder
      ref={setNodeRef}
      data-testid="streamer-row"
      padding="sm"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // The lifted row rides above its neighbours as they slide under it.
        zIndex: isDragging ? 1 : undefined,
        opacity: isDragging ? 0.6 : undefined,
        // Tied to the badge, so the tint marks what is being mined rather
        // than the first two positions. The number in the row already says
        // where a streamer sits in the order; tinting by position as well
        // restated it in a way that read as "these two are active".
        ...(watching
          ? { background: "rgba(145,71,255,0.08)", borderColor: "var(--tw-purple)" }
          : {}),
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ActionIcon
            variant="subtle"
            color="gray"
            ref={setActivatorNodeRef}
            aria-label={`Reorder ${username}`}
            style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
            {...attributes}
            {...listeners}
          >
            <IconGripVertical size={16} />
          </ActionIcon>
          <Text size="sm" c="dimmed" ff="monospace" w={20}>{index + 1}</Text>
          <StreamerAvatar
            login={username}
            avatarUrl={status?.avatarUrl ?? null}
            size={28}
            live={status?.isOnline === true}
          />
          <Text
            component="a"
            href={`https://twitch.tv/${username}`}
            target="_blank"
            rel="noopener noreferrer"
            fw={500}
            style={{ color: "inherit", textDecoration: "none" }}
          >
            {username}
          </Text>
          {/* `title` rather than a Mantine <Tooltip>, which hangs the
              vitest worker. */}
          {watching && (
            <Badge
              size="xs" variant="light" color="twitch" data-testid="watching-tag"
              title="The miner is currently watching this channel."
            >
              watching
            </Badge>
          )}
          {/* Live state is what the ordering decision is actually made on,
              so it sits on the row being dragged. Absent when the miner is
              unreachable -- see StatusPill. */}
          <StatusPill
            isOnline={status?.isOnline ?? null}
            liveSince={status?.liveSince ?? null}
            lastLive={status?.lastLive ?? null}
          />
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Switch
            checked={enabled}
            onChange={onToggle}
            aria-label={`Enable ${username}`}
          />
          {/* Removal is staged like every other edit on this screen -- it
              drops the row from the draft and the pending bar counts it, so
              a stray click costs an Apply, not a config. `title` rather than
              a Mantine <Tooltip>, which hangs the vitest worker. */}
          <ActionIcon
            variant="subtle"
            color="red"
            onClick={onRemove}
            aria-label={`Remove ${username}`}
            title={`Remove ${username}`}
          >
            <IconX size={16} />
          </ActionIcon>
        </Group>
      </Group>
    </Card>
  );
}
