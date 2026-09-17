import { Badge, Group, Progress, Stack, Text } from "@mantine/core";

/** What a single drop is doing for this viewer -- mirrors dropState.ts. */
export type DropStatus =
  | "unobtainable"
  | "claimed"
  | "claimable"
  | "in-progress"
  | "not-started"
  | "unknown";

export interface ResolvedDrop {
  id: string;
  name: string;
  benefits: string[];
  requiredMinutes: number;
  minutes: number;
  status: DropStatus;
}

/** The short label beside each drop, and the colour carrying its urgency. */
const STATE: Record<DropStatus, { label: string; colour: string }> = {
  // Says *why* it can never be earned. Left as a bare "not started" it
  // reads as a bug when "collect all drops" never completes.
  unobtainable: { label: "needs sub", colour: "gray" },
  claimed: { label: "claimed", colour: "gray" },
  // Filled orange below: the one state that wants acting on, matching
  // the language DropBadge already set on the dashboard.
  claimable: { label: "ready to claim", colour: "orange" },
  "in-progress": { label: "in progress", colour: "orange" },
  "not-started": { label: "not started", colour: "gray" },
  unknown: { label: "progress unknown", colour: "gray" },
};

/**
 * One drop in a campaign: what it awards, what it costs, where you are.
 *
 * A bar is drawn only while a drop is actually being earned. A finished
 * or unearnable drop with a full or empty bar invites reading it as
 * progress, and `unknown` must never render a bar at all -- a zeroed one
 * is a confident claim of no progress, which is exactly what a failed
 * inventory fetch cannot support. That case shows an em-dash instead,
 * the same way Gain reports an unknown balance.
 */
export function DropRow({ drop }: { drop: ResolvedDrop }) {
  const state = STATE[drop.status];
  const showBar = drop.status === "in-progress";
  const unknown = drop.status === "unknown";
  const muted = drop.status === "claimed" || drop.status === "unobtainable";

  return (
    <Stack gap={2} data-testid="drop-row" data-status={drop.status}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="sm" fw={500} c={muted ? "dimmed" : undefined}>
          {drop.name}
        </Text>
        <Badge
          size="sm"
          color={state.colour}
          variant={drop.status === "claimable" ? "filled" : "light"}
          data-testid="drop-state"
        >
          {state.label}
        </Badge>
      </Group>

      {drop.benefits.length > 0 && (
        <Text size="xs" c="dimmed" data-testid="drop-benefits">
          {drop.benefits.join(", ")}
        </Text>
      )}

      <Text size="xs" c="dimmed" data-testid="drop-progress">
        {unknown
          ? `— / ${drop.requiredMinutes}m`
          : drop.status === "in-progress"
            ? `${drop.minutes}/${drop.requiredMinutes}m`
            : `${drop.requiredMinutes}m`}
      </Text>

      {showBar && (
        <Progress
          value={(drop.minutes / drop.requiredMinutes) * 100}
          color="orange"
          size="sm"
          data-testid="drop-bar"
          aria-label={`${drop.name} progress`}
        />
      )}
    </Stack>
  );
}
