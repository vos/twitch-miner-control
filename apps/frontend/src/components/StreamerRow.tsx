import { ActionIcon, Badge, Card, Group, Switch, Text } from "@mantine/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconGripVertical } from "@tabler/icons-react";
import { StatusPill } from "./StatusPill.js";
import { StreamerAvatar } from "./StreamerAvatar.js";

/** What the live snapshot knows about this channel; null when unreachable. */
export interface RowStatus {
  avatarUrl: string | null;
  isOnline: boolean | null;
  liveSince: number | null;
  lastLive: number | null;
}

interface Props {
  username: string;
  enabled: boolean;
  status: RowStatus | null;
  /** 0-based position, shown as the priority number and drives the tint. */
  index: number;
  /** True for the rows the miner actually watches -- the top two. */
  watching: boolean;
  onToggle: () => void;
}

/**
 * One draggable row of the streamer priority list.
 *
 * The drag listeners sit on the grip, not the card: the row also holds a
 * channel link (natively draggable) and a switch, and a whole-card handle
 * makes those fight the reorder.
 */
export function StreamerRow(
  { username, enabled, status, index, watching, onToggle }: Props,
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
          {watching && (
            <Badge size="xs" variant="light" color="twitch" data-testid="watching-tag">
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
        <Switch
          checked={enabled}
          onChange={onToggle}
          aria-label={`Enable ${username}`}
        />
      </Group>
    </Card>
  );
}
