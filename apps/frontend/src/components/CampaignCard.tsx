import {
  Badge, Button, Card, Collapse, Group, Stack, Text, UnstyledButton,
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
 * The collection state alone knows nothing about the campaign's window,
 * so an expired campaign announced itself as "not started" -- an
 * invitation to start something that cannot be started -- or as "in
 * progress", a claim about something that is no longer happening. Once
 * the window shuts, that progress is frozen and can never be finished.
 *
 * `collected` is the exception and survives: it is a real achievement,
 * and the deadline passing does not undo it.
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
export function CampaignCard({ campaign, subscribed, onSubscribe, onUnsubscribe }: {
  campaign: ResolvedCampaign;
  /** Whether a subscription already targets this campaign. */
  subscribed?: boolean;
  onSubscribe?: () => void;
  onUnsubscribe?: () => void;
}) {
  const [open, { toggle }] = useDisclosure(false);
  const status = badge(campaign.status, campaign.endsAt);
  const count = campaign.drops.length;

  return (
    <Card withBorder padding="sm" data-testid="campaign-card">
      {/* The subscribe button is a SIBLING of the disclosure button, not
          a child. Nesting one interactive element inside another is
          invalid, needs stopPropagation to stop a subscribe also
          expanding the card, and leaves a keyboard user no way to reach
          the inner control. */}
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

        {onSubscribe !== undefined && (
          <Button
            size="compact-xs"
            variant={subscribed === true ? "light" : "filled"}
            color={subscribed === true ? "gray" : "orange"}
            onClick={() => {
              if (subscribed === true) onUnsubscribe?.();
              else onSubscribe();
            }}
          >
            {subscribed === true ? "Unsubscribe" : "Subscribe"}
          </Button>
        )}
      </Group>

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
