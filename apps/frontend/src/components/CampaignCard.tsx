import {
  Badge, Button, Card, Collapse, Group, Loader, Stack, Text, UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconChevronDown } from "@tabler/icons-react";
import { formatSpan } from "../lib/formatSpan.js";
import { DropRow, type ResolvedDrop } from "./DropRow.js";

export type CampaignStatus = "collected" | "partial" | "untouched" | "unknown";

export interface ResolvedCampaign {
  id: string;
  name: string;
  game: { id: string; slug: string; displayName: string } | null;
  startsAt: number | null;
  endsAt: number | null;
  drops: ResolvedDrop[];
  status: CampaignStatus;
}

const STATUS: Record<CampaignStatus, { label: string; colour: string }> = {
  collected: { label: "collected", colour: "teal" },
  partial: { label: "in progress", colour: "orange" },
  untouched: { label: "not started", colour: "gray" },
  // Distinct from "not started" on purpose: we could not read the
  // inventory, which is not the same as knowing nothing was earned.
  unknown: { label: "progress unknown", colour: "gray" },
};

const ENDED = { label: "ended", colour: "gray" };

/**
 * The badge a campaign shows.
 *
 * Ended overrides the collection state, which knows nothing about the
 * campaign's window: "not started" on an expired campaign invites
 * starting something that cannot be started, and "in progress" claims
 * something is happening that is not -- once the window shuts that
 * progress is frozen and can never be finished.
 *
 * `collected` survives it: a real achievement, which the deadline
 * passing does not undo.
 */
function badge(status: CampaignStatus, endsAt: number | null) {
  // A campaign with no end date reported is not an ended one: unknown is
  // not passed.
  const over = endsAt !== null && endsAt <= Date.now();
  return over && status !== "collected" ? ENDED : STATUS[status];
}

/**
 * One drop campaign, with its drops behind a disclosure.
 *
 * Collapsed by default because the campaign list runs to a hundred or
 * more and every one expanded is unreadable. The collapsed row carries
 * what the list is actually scanned for -- the game, the deadline, and
 * whether this campaign is already done.
 */
export function CampaignCard({
  campaign, subscribed, onSubscribe, onUnsubscribe, busy,
}: {
  campaign: ResolvedCampaign;
  /** Whether a subscription already targets this campaign. */
  subscribed?: boolean;
  onSubscribe?: () => void;
  onUnsubscribe?: () => void;
  /**
   * What this card is waiting on, or undefined when idle.
   *
   * Shown on the row itself: resolving asks Twitch for a game's live
   * channels and takes seconds, and feedback where the click happened
   * cannot be mistaken for another campaign's.
   */
  busy?: string;
}) {
  const [open, { toggle }] = useDisclosure(false);
  const status = badge(campaign.status, campaign.endsAt);
  const count = campaign.drops.length;

  return (
    <Card withBorder padding="sm" data-testid="campaign-card">
      {/* The subscribe button is a sibling of the disclosure button:
          nesting one interactive element inside another is invalid and
          leaves a keyboard user no way to reach the inner control. */}
      <Group justify="space-between" wrap="nowrap" gap="xs" align="center">
        <UnstyledButton
          onClick={toggle}
          aria-expanded={open}
          aria-label={`${campaign.name}, ${count} drops`}
          style={{ flex: 1, minWidth: 0 }}
        >
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Text fw={600} size="sm" lineClamp={1}>{campaign.name}</Text>
              <Group gap="xs">
                {campaign.game !== null && (
                  <Text size="xs" c="dimmed" data-testid="campaign-game">
                    {campaign.game.displayName}
                  </Text>
                )}
                <Text size="xs" c="dimmed" data-testid="campaign-drop-count">
                  {count === 1 ? "1 drop" : `${count} drops`}
                </Text>
                {campaign.endsAt !== null && (
                  <Text size="xs" c="dimmed" data-testid="campaign-ends">
                    {/* Past tense once the window has shut: a finished
                        campaign is not "ending in -2d". */}
                    {campaign.endsAt <= Date.now()
                      ? "ended"
                      : `ends in ${formatSpan(campaign.endsAt - Date.now())}`}
                  </Text>
                )}
              </Group>
            </Stack>
            <Group gap="xs" wrap="nowrap">
              <Badge
                size="sm"
                color={status.colour}
                variant="light"
                data-testid="campaign-status"
              >
                {status.label}
              </Badge>
              <IconChevronDown
                size={16}
                style={{ transform: open ? "rotate(180deg)" : undefined }}
                aria-hidden
              />
            </Group>
          </Group>
        </UnstyledButton>

        {/* No explicit colour: the theme's primary is Twitch purple, so
            subscribing inherits the brand, leaving orange to mean "drop
            in progress" on the badge beside it. Subscribed goes neutral,
            unsubscribing not being an action to encourage. */}
        {onSubscribe !== undefined && (
          <Button
            size="compact-xs"
            variant={subscribed === true ? "default" : "filled"}
            // The button is what was clicked; leaving it inert while a
            // notice appears reads as the click not registering. Also
            // stops a second click racing the first.
            loading={busy !== undefined}
            onClick={() => {
              if (subscribed === true) onUnsubscribe?.();
              else onSubscribe();
            }}
          >
            {subscribed === true ? "Unsubscribe" : "Subscribe"}
          </Button>
        )}
      </Group>

      {busy !== undefined && (
        <Group gap="xs" wrap="nowrap" mt="xs" data-testid="campaign-busy">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">{busy}</Text>
        </Group>
      )}

      <Collapse expanded={open} keepMounted={false}>
        <Stack gap="sm" mt="sm">
          {campaign.drops.map((drop) => (
            <DropRow key={drop.id} drop={drop} />
          ))}
        </Stack>
      </Collapse>
    </Card>
  );
}
