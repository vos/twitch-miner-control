import { Badge, Popover, Progress, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { formatSpan } from "../lib/formatSpan.js";
import classes from "./DropBadge.module.css";
import type { StreamerState } from "../api/useLiveState.js";

type Drop = NonNullable<StreamerState["drop"]>;

/**
 * The next drop a channel has to earn, with its detail behind a tap.
 *
 * A Popover rather than the Tooltip this started as, for the reason
 * StreamContext and MinerStatusBadge use one: a tooltip opens on hover
 * only, so on a phone the detail -- which is most of what makes a drop
 * worth knowing about -- was unreachable.
 *
 * The badge itself stays terse ("DROP 45/60m"): it sits in a strip with
 * three or four others, and a drop name like "Exclusive Weapon Charm"
 * would wrap the row at the dashboard's 320px minimum. The name, what it
 * awards and when the campaign ends all live in the panel.
 */
export function DropBadge({ drop }: { drop: Drop }) {
  const [opened, { open, close, toggle }] = useDisclosure(false);
  // Hover only where hovering is real: a tap synthesises mouseenter and
  // mouseleave around its click, and binding them unconditionally lets
  // the mouseleave close what the click just opened.
  const hoverable = typeof window !== "undefined"
    && window.matchMedia?.("(hover: hover)").matches === true;
  const hover = hoverable ? { onMouseEnter: open, onMouseLeave: close } : {};

  const left = Math.max(0, drop.required - drop.minutes);
  const benefits = drop.benefits ?? [];
  const endsAt = drop.endsAt ?? null;

  return (
    <Popover
      opened={opened}
      onDismiss={close}
      position="bottom-start"
      withArrow
      shadow="md"
      width={240}
    >
      <Popover.Target>
        {/* Orange, not the teal the points claim uses: a drop is a game
            reward rather than channel points, and two actionable badges
            sharing a colour cannot be told apart at a glance. Filled when
            ready, so the one badge that wants acting on outranks the
            light pills beside it. */}
        <Badge
          component="button"
          type="button"
          color="orange"
          variant={drop.claimable ? "filled" : "light"}
          size="sm"
          data-testid="drop"
          data-claimable={drop.claimable}
          className={classes.badge}
          {...hover}
          onClick={toggle}
          aria-expanded={opened}
          aria-label={
            drop.claimable
              ? `${drop.name} drop ready to claim`
              : `${drop.name} drop, ${drop.minutes} of ${drop.required} minutes`
          }
        >
          {drop.claimable ? "drop ready" : `drop ${drop.minutes}/${drop.required}m`}
        </Badge>
      </Popover.Target>
      <Popover.Dropdown data-testid="drop-detail">
        <Text size="xs" fw={600}>{drop.name}</Text>

        <Progress
          value={(drop.minutes / drop.required) * 100}
          color="orange"
          size="sm"
          mt={6}
          aria-label={`${drop.name} progress`}
        />

        <Text size="xs" c="dimmed" mt={4} data-testid="drop-remaining">
          {/* "0 minutes to go" on a finished drop reads as though it were
              still counting; what changed is that it can be collected. */}
          {left === 0
            ? `${drop.minutes}/${drop.required}m · ready to claim`
            : `${drop.minutes}/${drop.required}m · ${left} min to go`}
        </Text>

        {benefits.length > 0 && (
          <Text size="xs" mt={6} data-testid="drop-benefits">
            {benefits.join(", ")}
          </Text>
        )}

        {endsAt !== null && (
          <Text size="xs" c="dimmed" mt={4} data-testid="drop-ends">
            {/* Past tense once the campaign has closed: a drop whose
                window shut is not "ending in -2d". */}
            {endsAt <= Date.now()
              ? "Campaign ended"
              : `Ends in ${formatSpan(endsAt - Date.now())}`}
          </Text>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
