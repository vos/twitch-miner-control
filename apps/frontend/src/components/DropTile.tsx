import { Badge, Group, Progress, Stack, Text, Tooltip } from "@mantine/core";
import { RewardIcon } from "./RewardIcon.js";
import classes from "./DropTile.module.css";

/** What a single drop is doing for this viewer -- mirrors dropState.ts. */
export type DropStatus =
  | "unobtainable"
  | "claimed"
  | "claimable"
  | "in-progress"
  | "not-started"
  | "unknown";

/** One award from a drop: what it is called, and what it looks like. */
export interface DropBenefit {
  name: string;
  imageUrl: string | null;
}

export interface ResolvedDrop {
  id: string;
  name: string;
  benefits: DropBenefit[];
  requiredMinutes: number;
  minutes: number;
  status: DropStatus;
  /** The drop's own window, narrower than its campaign's on some. */
  startsAt?: number | null;
  endsAt?: number | null;
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
 * The reward this drop is best represented by, or null when it has none.
 *
 * The first benefit, because a drop granting several awards them
 * together -- there is no "main" one to pick, and the tile has room for
 * a single image. The rest are named in the subtitle.
 */
function cover(drop: ResolvedDrop): DropBenefit | null {
  return drop.benefits[0] ?? null;
}

/**
 * The benefit names worth printing under a drop's own name.
 *
 * Dropped when they would only repeat it: a drop called "Hazmat Suit"
 * awarding a "Hazmat Suit" renders the same words twice, which reads as
 * a rendering fault rather than detail.
 */
function subtitle(drop: ResolvedDrop): string | null {
  const listed = drop.benefits.map((b) => b.name).join(", ");
  if (listed === "" || listed.toLowerCase() === drop.name.toLowerCase()) {
    return null;
  }
  return listed;
}

/**
 * One drop as a gallery tile: what it awards, what it costs, where you are.
 *
 * A bar is drawn only while a drop is actually being earned. A finished
 * or unearnable drop with a full or empty bar invites reading it as
 * progress, and `unknown` must never render a bar at all -- a zeroed one
 * is a confident claim of no progress, which is exactly what a failed
 * inventory fetch cannot support. That case shows an em-dash instead,
 * the same way Gain reports an unknown balance.
 */
export function DropTile({ drop }: { drop: ResolvedDrop }) {
  const state = STATE[drop.status];
  const showBar = drop.status === "in-progress";
  const unknown = drop.status === "unknown";
  const muted = drop.status === "claimed" || drop.status === "unobtainable";
  const art = cover(drop);
  const benefits = subtitle(drop);

  return (
    <Stack
      gap={6}
      className={classes.tile}
      data-testid="drop-row"
      data-status={drop.status}
    >
      <Group gap="xs" wrap="nowrap" align="flex-start">
        {/* Dimmed once claimed or unearnable, so a finished campaign's
            tiles recede rather than competing with the ones still worth
            watching for. */}
        <div className={muted ? classes.mutedArt : undefined}>
          <RewardIcon
            name={art?.name ?? drop.name}
            imageUrl={art?.imageUrl ?? null}
            size={40}
          />
        </div>

        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={500} lineClamp={2} c={muted ? "dimmed" : undefined}>
            {drop.name}
          </Text>

          {benefits !== null && (
            <Text size="xs" c="dimmed" lineClamp={1} data-testid="drop-benefits">
              {benefits}
            </Text>
          )}

          {/* The badge sits under the name rather than beside it: these
              tiles are two to a row inside an already-narrow card, and a
              badge reading "progress unknown" on the same line leaves the
              name no width at all -- it collapses to nothing and the
              minutes wrap one character per line. */}
          <Group gap={6} wrap="nowrap" justify="space-between" mt={2}>
            <Text
              size="xs"
              c="dimmed"
              style={{ whiteSpace: "nowrap" }}
              data-testid="drop-progress"
            >
              {unknown
                ? `— / ${drop.requiredMinutes}m`
                : drop.status === "in-progress"
                  ? `${drop.minutes}/${drop.requiredMinutes}m`
                  : `${drop.requiredMinutes}m`}
            </Text>
            <Badge
              size="xs"
              color={state.colour}
              variant={drop.status === "claimable" ? "filled" : "light"}
              data-testid="drop-state"
            >
              {state.label}
            </Badge>
          </Group>
        </Stack>
      </Group>

      {showBar && (
        <Tooltip label={`${drop.minutes} of ${drop.requiredMinutes} minutes watched`}>
          <Progress
            value={(drop.minutes / drop.requiredMinutes) * 100}
            color="orange"
            size="sm"
            data-testid="drop-bar"
            aria-label={`${drop.name} progress`}
          />
        </Tooltip>
      )}
    </Stack>
  );
}
