import { ActionIcon, Badge, Button, Card, Group, Stack, Text } from "@mantine/core";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter,
  type DragEndEvent, useSensor, useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconGripVertical, IconPlus, IconX } from "@tabler/icons-react";

/**
 * Every priority the miner understands, with a label.
 *
 * Order here is only the order unselected options are offered in; the
 * selected list carries its own order, which is the one that reaches the
 * miner. Mirrors PRIORITIES in apps/backend/src/config/schema.ts, which the
 * frontend cannot import across the package boundary.
 */
export const PRIORITY_LABELS: Array<[string, string]> = [
  ["STREAK", "Watch streaks"], ["DROPS", "Drops"], ["SUBSCRIBED", "Subscribed"],
  ["WATCH_SESSION", "Watch session"], ["WEEKLY_REWARDS", "Weekly rewards"],
  ["ORDER", "List order"], ["POINTS_ASCENDING", "Fewest points first"],
  ["POINTS_DESCENDING", "Most points first"],
];

const labelOf = (value: string) =>
  PRIORITY_LABELS.find(([v]) => v === value)?.[1] ?? value;

/**
 * The order the miner uses when given no `priority` at all.
 *
 * Not a guess: with `priority=None` the constructor builds
 * `NestedSelector([watch_session(), watch_streak(), weekly_rewards_selector(),
 * drops(), order()])` (TwitchChannelPointsMiner.py). Note it is five of the
 * eight rules -- SUBSCRIBED and the points orderings are not consulted
 * unless you ask for them.
 */
export const DEFAULT_PRIORITY = [
  "WATCH_SESSION", "STREAK", "WEEKLY_REWARDS", "DROPS", "ORDER",
] as const;

interface Props {
  /** The selected priorities, in the order the miner will read them. */
  value: string[];
  onChange: (next: string[]) => void;
}

/**
 * The miner-wide priority list: which rules pick the next channel, and in
 * what order they are consulted.
 *
 * Two zones rather than one sortable list of everything, because a
 * priority has a position only once it is selected -- upstream's `priority`
 * is a list of the rules to apply, not a ranking of all eight. Selected
 * rules are draggable; the rest are add-buttons. An empty selection is
 * meaningful: Settings drops the key entirely, which is how upstream is
 * told to use its own built-in ordering.
 */
export function PriorityList({ value, onChange }: Props) {
  // Matches the streamer list: an activation distance keeps a click on the
  // grip from registering as a drag, and the keyboard sensor is the only
  // reorder path for a keyboard user.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    // No `over` means the drag was cancelled or released outside the list.
    if (!over || active.id === over.id) return;
    const from = value.indexOf(String(active.id));
    const to = value.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onChange(arrayMove(value, from, to));
  };

  const unselected = PRIORITY_LABELS
    .map(([v]) => v)
    .filter((v) => !value.includes(v));

  return (
    <Stack gap="xs">
      <div>
        <Text size="sm" fw={500}>Priority</Text>
        <Text size="xs" c="dimmed">
          What the miner reaches for first when choosing which channels to
          watch. The miner works down this list in order, so the topmost rule
          that matches a channel wins. Add none to use the built-in order.
        </Text>
      </div>

      {value.length === 0 ? (
        // Spelling the built-in order out, rather than only naming it: with
        // nothing selected there is otherwise no way to know what the miner
        // will actually do short of reading upstream's source.
        <Stack gap={4} data-testid="priority-empty">
          <Text size="sm" c="dimmed" fs="italic">
            Using the miner's built-in order:
          </Text>
          <Group gap={6} wrap="wrap">
            {DEFAULT_PRIORITY.map((priority, index) => (
              <Group key={priority} gap={6} wrap="nowrap">
                {index > 0 && <Text size="xs" c="dimmed">→</Text>}
                <Badge size="sm" variant="default">{labelOf(priority)}</Badge>
              </Group>
            ))}
          </Group>
          <Text size="xs" c="dimmed">
            Add rules below to replace this with your own order.
          </Text>
        </Stack>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={value} strategy={verticalListSortingStrategy}>
            <Stack gap={6}>
              {value.map((priority, index) => (
                <PriorityRow
                  key={priority}
                  value={priority}
                  index={index}
                  onRemove={() => onChange(value.filter((v) => v !== priority))}
                />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}

      {unselected.length > 0 && (
        <Group gap="xs" mt="xs">
          {unselected.map((priority) => (
            <Button
              key={priority}
              size="compact-sm"
              variant="default"
              leftSection={<IconPlus size={14} />}
              onClick={() => onChange([...value, priority])}
            >
              {labelOf(priority)}
            </Button>
          ))}
        </Group>
      )}
    </Stack>
  );
}

/** One draggable rule in the priority order. */
function PriorityRow(
  { value, index, onRemove }: { value: string; index: number; onRemove: () => void },
) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform,
    transition, isDragging,
  } = useSortable({ id: value });

  return (
    <Card
      withBorder
      ref={setNodeRef}
      data-testid="priority-row"
      padding="xs"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // The lifted row rides above its neighbours as they slide under it.
        zIndex: isDragging ? 1 : undefined,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ActionIcon
            variant="subtle"
            color="gray"
            ref={setActivatorNodeRef}
            aria-label={`Reorder ${labelOf(value)}`}
            style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
            {...attributes}
            {...listeners}
          >
            <IconGripVertical size={16} />
          </ActionIcon>
          <Text size="sm" c="dimmed" ff="monospace" w={20}>{index + 1}</Text>
          <Text size="sm" fw={500}>{labelOf(value)}</Text>
          {index === 0 && (
            <Badge size="xs" variant="light" color="twitch">first</Badge>
          )}
        </Group>
        {/* `title` rather than a Mantine <Tooltip>, which hangs the vitest
            worker. */}
        <ActionIcon
          variant="subtle"
          color="red"
          onClick={onRemove}
          aria-label={`Remove ${labelOf(value)}`}
          title={`Remove ${labelOf(value)}`}
        >
          <IconX size={16} />
        </ActionIcon>
      </Group>
    </Card>
  );
}
