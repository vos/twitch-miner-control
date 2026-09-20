import {
  Badge, Group, Popover, Progress, Stack, Text, Tooltip, UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { narrowerWindow, windowLines } from "../lib/campaignWindow.js";
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
  //
  // Phrased about watching rather than about subs, because that is the
  // most the signals actually support: a zero-minute requirement and an
  // unmet precondition both mean "the gate is something other than
  // watch time" without saying which, and the gate is a gift sub on
  // some drops, an account link or an external hunt on others. The
  // older "needs sub" stated a reason the app had not established.
  unobtainable: { label: "not earned by watching", colour: "gray" },
  claimed: { label: "claimed", colour: "gray" },
  // Filled orange below: the one state that wants acting on, matching
  // the language DropBadge already set on the dashboard.
  claimable: { label: "ready to claim", colour: "orange" },
  "in-progress": { label: "in progress", colour: "orange" },
  "not-started": { label: "not started", colour: "gray" },
  unknown: { label: "progress unknown", colour: "gray" },
};

/**
 * What this drop awards, as rows to render.
 *
 * Every benefit gets its own icon and label. The tile used to draw only
 * `benefits[0]` and cram the rest into one clamped line of text, which
 * meant a drop awarding eight items showed one picture and a truncated
 * list -- the other seven had artwork in the catalogue that appeared
 * nowhere in the app, not even behind the collapsed card's "+N".
 *
 * A drop with nothing named still yields one row, standing for the drop
 * itself: it awards something, and a tile with no artwork at all reads
 * as a failed load. That row is left unlabelled, since the drop's name
 * is already printed directly above it.
 */
function benefitRows(
  drop: ResolvedDrop,
): { key: string; name: string; imageUrl: string | null; label: string | null }[] {
  if (drop.benefits.length === 0) {
    return [{ key: drop.id, name: drop.name, imageUrl: null, label: null }];
  }
  return drop.benefits.map((b, at) => ({
    key: `${b.name}\u0000${at}`,
    name: b.name,
    imageUrl: b.imageUrl,
    // Dropped when it would only repeat the drop's own name: a "Hazmat
    // Suit" awarding a "Hazmat Suit" renders the same words twice,
    // which reads as a rendering fault rather than as detail.
    label: b.name.toLowerCase() === drop.name.toLowerCase() ? null : b.name,
  }));
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
export function DropTile({ drop, campaignStartsAt = null, campaignEndsAt = null }: {
  drop: ResolvedDrop;
  /**
   * The campaign's own window, for comparison.
   *
   * A drop's dates are shown only when they differ from these -- see
   * narrowerWindow. Without them the tile cannot tell a real sub-window
   * from a copy of the campaign's, so it shows none.
   */
  campaignStartsAt?: number | null;
  campaignEndsAt?: number | null;
}) {
  const state = STATE[drop.status];
  const showBar = drop.status === "in-progress";
  const unknown = drop.status === "unknown";
  const muted = drop.status === "claimed" || drop.status === "unobtainable";
  const rows = benefitRows(drop);
  const own = narrowerWindow(drop, campaignStartsAt, campaignEndsAt);
  const ownDates = own === null
    ? null
    : windowLines(own.startsAt, own.endsAt, Date.now());

  const [windowOpen, { open: openWindow, close: closeWindow, toggle: toggleWindow }] =
    useDisclosure(false);
  // See DropBadge: a tap synthesises mouseenter/mouseleave around its
  // click, so binding hover unconditionally closes what the tap opened.
  const hoverable = typeof window !== "undefined"
    && window.matchMedia?.("(hover: hover)").matches === true;
  const windowHover = hoverable
    ? { onMouseEnter: openWindow, onMouseLeave: closeWindow }
    : {};

  // A drop awarding one thing is the common case and reads best as a
  // single line: the big icon beside the name, the way the tile looked
  // before the gallery learned to show every reward. Stacking that one
  // reward into a list orphans the name on a row of its own, shrinks the
  // art for no reason and makes every tile taller than it needs to be.
  const single = rows.length === 1;

  const meta = (
    /* The cost and the state, on the tile's last line. Kept off the
       name's row: these tiles are two to a row inside an already-narrow
       card, and a badge reading "progress unknown" beside the name
       leaves it no width at all -- it collapses to nothing and the
       minutes wrap one character per line. */
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
      <Group gap={6} wrap="nowrap">
        {/* Only when this drop runs for a slice of its campaign rather
            than the whole of it. Every drop in the current catalogue
            repeats its campaign's window, so this stays hidden -- but
            Twitch's model allows a "week two" reward inside a longer
            event, and when one appears the tile must say so: its
            deadline is not the one the card above it reports. */}
        {ownDates !== null && ownDates.rows.length > 0 && (
          <Popover
            opened={windowOpen}
            onDismiss={closeWindow}
            position="bottom-end"
            withArrow
            shadow="md"
          >
            <Popover.Target>
              <UnstyledButton
                {...windowHover}
                onClick={toggleWindow}
                aria-expanded={windowOpen}
                aria-label={`${drop.name} drop window`}
                className={classes.windowNote}
                data-testid="drop-window-note"
              >
                own window
              </UnstyledButton>
            </Popover.Target>
            <Popover.Dropdown data-testid="drop-window">
              <Stack gap={4}>
                {ownDates.rows.map((row) => (
                  <Group key={row.label} gap="sm" wrap="nowrap"
                         justify="space-between">
                    <Text size="xs" c="dimmed">{row.label}</Text>
                    <Text size="xs" fw={500}>{row.value}</Text>
                  </Group>
                ))}
                {/* Set apart from the dates, as on the campaign card. */}
                {ownDates.state !== null && (
                  <Text size="xs" c="dimmed" mt={4}>{ownDates.state}</Text>
                )}
              </Stack>
            </Popover.Dropdown>
          </Popover>
        )}
        <Badge
          size="xs"
          color={state.colour}
          variant={drop.status === "claimable" ? "filled" : "light"}
          data-testid="drop-state"
        >
          {state.label}
        </Badge>
      </Group>
    </Group>
  );

  const name = (
    <Text size="sm" fw={500} lineClamp={2} c={muted ? "dimmed" : undefined}>
      {drop.name}
    </Text>
  );

  /* Dimmed once claimed or unearnable, so a finished campaign's tiles
     recede rather than competing with the ones still worth watching
     for. */
  const icon = (row: typeof rows[number], size: number) => (
    <div className={muted ? classes.mutedArt : undefined}>
      <RewardIcon name={row.name} imageUrl={row.imageUrl} size={size} />
    </div>
  );

  return (
    <Stack
      gap={6}
      className={classes.tile}
      data-testid="drop-row"
      data-status={drop.status}
    >
      {single ? (
        <Group gap="xs" wrap="nowrap" align="flex-start"
               data-testid="drop-benefit">
          {icon(rows[0], 40)}
          <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
            {name}
            {meta}
          </Stack>
        </Group>
      ) : (
        <Stack gap={4}>
          {name}
          {/* One row per award, each with its own artwork. Stacked
              rather than a bare icon grid so every reward is readable
              without hovering -- these names carry the quantities
              ("5m Speedup*12"), which is most of what distinguishes one
              from another. */}
          <Stack gap={4} data-testid="drop-benefit-list">
            {rows.map((row) => (
              <Group key={row.key} gap={6} wrap="nowrap" align="center"
                     data-testid="drop-benefit">
                {icon(row, 24)}
                {row.label !== null && (
                  <Text size="xs" c="dimmed" className={classes.benefitName}>
                    {row.label}
                  </Text>
                )}
              </Group>
            ))}
          </Stack>
          {meta}
        </Stack>
      )}

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
