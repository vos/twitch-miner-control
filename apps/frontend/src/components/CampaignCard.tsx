import {
  Anchor, Badge, Button, Card, Collapse, Group, Loader, Popover, Progress,
  Stack, Text, Tooltip, UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useState } from "react";
import { IconChevronDown, IconExternalLink } from "@tabler/icons-react";
import { formatSpan } from "../lib/formatSpan.js";
import { windowLines } from "../lib/campaignWindow.js";
import { CampaignBoxArt } from "./CampaignBoxArt.js";
import { DropTile, type ResolvedDrop } from "./DropTile.js";
import { RewardIcon } from "./RewardIcon.js";
import classes from "./CampaignCard.module.css";

export type CampaignStatus = "collected" | "partial" | "untouched" | "unknown";

export interface CampaignGame {
  id: string;
  slug: string;
  displayName: string;
  boxArtUrl?: string | null;
}

export interface ResolvedCampaign {
  id: string;
  name: string;
  game: CampaignGame | null;
  owner?: { name: string; type: string } | null;
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
 * A campaign whose window has not opened yet.
 *
 * Distinct from "not started", which is about your progress: that badge
 * on an unopened campaign invites starting something that cannot be
 * started. Purple rather than grey, matching the countdown beside it --
 * this is a campaign to come back for, not a dormant one.
 */
const SCHEDULED = { label: "scheduled", colour: "violet" };

/**
 * How many reward icons a collapsed card shows before summarising.
 *
 * Five fits: at 26px plus a 4px gap that is 150px of a card whose text
 * column runs to roughly 290px at the page's three-column width, leaving
 * room for the "+N" beside it.
 */
const ICON_CAP = 5;

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
function badge(
  status: CampaignStatus,
  startsAt: number | null,
  endsAt: number | null,
  now: number,
) {
  // A campaign with no end date reported is not an ended one: unknown is
  // not passed.
  const over = endsAt !== null && endsAt <= now;
  if (over && status !== "collected") return ENDED;
  // Checked after ended, which a scheduled campaign cannot also be, and
  // before the progress states, which cannot have happened yet. Progress
  // already earned still wins: a drop claimed in an earlier run of a
  // recurring campaign is a real achievement to report.
  if (scheduled(startsAt, now) && status !== "collected"
      && status !== "partial") {
    return SCHEDULED;
  }
  return STATUS[status];
}

/** Whether a campaign's window has yet to open. */
export function scheduled(startsAt: number | null, now: number): boolean {
  return startsAt !== null && startsAt > now;
}

/**
 * How far through its window a campaign is, 0-100, or null when unknown.
 *
 * Null rather than zero for a campaign missing either date: a bar at
 * zero claims the window just opened, which is a fact we do not have. A
 * campaign that has not started yet reads as 0 legitimately, and one
 * past its end clamps to 100 rather than overflowing the track.
 */
export function elapsedPercent(
  startsAt: number | null,
  endsAt: number | null,
  now: number,
): number | null {
  if (startsAt === null || endsAt === null) return null;
  const span = endsAt - startsAt;
  // A zero or negative span is not a window to be partway through.
  if (span <= 0) return null;
  return Math.min(100, Math.max(0, ((now - startsAt) / span) * 100));
}

/**
 * How many of a campaign's drops are already claimed, and how many could be.
 *
 * Unobtainable drops are excluded from both halves, matching the
 * campaign status rule: they can never be earned by watching, so
 * counting them would leave a fully-earned campaign showing a bar that
 * never fills.
 */
export function claimedCount(drops: ResolvedDrop[]): {
  claimed: number;
  obtainable: number;
} {
  const obtainable = drops.filter((d) => d.status !== "unobtainable");
  return {
    claimed: obtainable.filter((d) => d.status === "claimed").length,
    obtainable: obtainable.length,
  };
}

/**
 * A campaign's watch time: what it costs, how far in you are, how much
 * of that is already banked as claimed drops.
 *
 * Twitch counts ONE running total per campaign and tests it against each
 * drop's own threshold, so the drops are cumulative milestones rather
 * than separate errands. Two consequences the bar depends on:
 *
 *   - The campaign costs the LONGEST requirement, not the sum. A
 *     15/30/60 campaign is an hour of watching, not 105 minutes; summing
 *     would price it at nearly double and make a finished campaign read
 *     as half done.
 *   - Watch time is the HIGHEST minutes any drop reports. Each entry is
 *     clamped to its own requirement, so a satisfied 15m drop reports 15
 *     forever while the total runs on -- reading the first drop, or the
 *     in-progress one alone, understates it.
 *
 * Unobtainable drops are excluded throughout, matching the campaign
 * status rule: they can never be earned by watching, so a 240m gated
 * drop would stretch the track to a length no amount of watching
 * reaches.
 *
 * Null when there is nothing to draw -- no obtainable drops, or none of
 * them costing any time, which would divide by a zero span.
 */
export function watchTime(drops: ResolvedDrop[]): {
  /** Minutes the campaign asks for in total. */
  required: number;
  /** Minutes watched so far, clamped to `required`. */
  watched: number;
  /** Minutes already banked as claimed drops. */
  claimed: number;
} | null {
  const earnable = drops.filter((d) => d.status !== "unobtainable");
  if (earnable.length === 0) return null;

  const required = Math.max(...earnable.map((d) => d.requiredMinutes));
  if (required <= 0) return null;

  // Clamped: inconsistent inventory data reporting more minutes than the
  // campaign asks for would otherwise overflow the track.
  const watched = Math.min(
    required,
    Math.max(0, ...earnable.map((d) => d.minutes)),
  );

  // The threshold of the furthest drop actually claimed. Not a count and
  // not a sum: it is the point along the same minute scale that the
  // claimed segment reaches.
  const claimedDrops = earnable.filter((d) => d.status === "claimed");
  const claimed = claimedDrops.length === 0
    ? 0
    : Math.min(required, Math.max(...claimedDrops.map((d) => d.requiredMinutes)));

  return { required, watched, claimed };
}

/**
 * Where each drop's threshold falls along the bar, as percentages.
 *
 * Positioned in minutes like the segments themselves, so the marks land
 * where the drops actually are: several close together early, then a
 * long empty run to the finale. That spacing is the point -- it shows at
 * a glance which milestone is nearly reached and how much further the
 * next one is.
 *
 * The final threshold is left out: it is the end of the track, where a
 * tick is indistinguishable from the border and marks nothing new.
 * Duplicates collapse to one mark, since two rewards at the same watch
 * time are one milestone -- drawn twice they would only thicken the
 * line. Unobtainable drops get none, matching the span they are excluded
 * from: a mark for a drop no amount of watching reaches points at a
 * milestone that never arrives.
 */
export function milestones(drops: ResolvedDrop[], required: number): number[] {
  if (required <= 0) return [];
  const at = new Set<number>();
  for (const drop of drops) {
    if (drop.status === "unobtainable") continue;
    // Strictly inside the track: 0 would sit under the left edge and the
    // final threshold is the right edge.
    if (drop.requiredMinutes <= 0 || drop.requiredMinutes >= required) continue;
    // Rounded to two places so positions that differ only by floating
    // point noise dedupe rather than drawing two touching lines.
    at.add(Math.round((drop.requiredMinutes / required) * 10000) / 100);
  }
  return [...at].sort((a, b) => a - b);
}

/** Every reward across a campaign's drops, in drop order. */
function rewards(drops: ResolvedDrop[]) {
  return drops.flatMap((d) =>
    d.benefits.length > 0
      ? d.benefits
      // A drop with no benefit listed still awards something; the drop's
      // own name is the best label available for it.
      : [{ name: d.name, imageUrl: null }],
  );
}

/**
 * One drop campaign as a grid card, with its rewards behind a disclosure.
 *
 * Leads with the game rather than the campaign: the box art beside it
 * shows the game, and a title naming something else makes the pairing
 * read as a mismatch. The campaign name sits under it, which is also
 * where a reader looks for "which of this game's campaigns is this".
 *
 * Collapsed, the card carries what the list is scanned for -- the game,
 * the time left, a glimpse of the rewards, and whether this one is
 * already done. Expanded, it shows every reward as a labelled tile.
 */
export function CampaignCard({
  campaign, subscribed, onSubscribe, onUnsubscribe, busy, expand = false,
}: {
  campaign: ResolvedCampaign;
  /**
   * Force the drops open regardless of the disclosure.
   *
   * Set when the card survived a filter only because a drop inside it
   * matched: collapsed, it would show nothing containing what was typed.
   * The toggle still works while this is set, so a reader who wants the
   * row back can close it.
   */
  expand?: boolean;
  /** Whether a subscription already targets this campaign. */
  subscribed?: boolean;
  onSubscribe?: () => void;
  onUnsubscribe?: () => void;
  /**
   * What this card is waiting on, or undefined when idle.
   *
   * Shown on the card itself: resolving asks Twitch for a game's live
   * channels and takes seconds, and feedback where the click happened
   * cannot be mistaken for another campaign's.
   */
  busy?: string;
}) {
  const [open, { toggle, set }] = useDisclosure(expand);
  // useDisclosure reads its argument once, so follow `expand` when it
  // flips -- typing a drop name opens the card, clearing the box closes
  // it again. Tracking the previous value rather than running an effect
  // keeps a reader's own toggle in between: this only fires on the
  // transition, not on every render while the filter stands.
  const [wasExpanded, setWasExpanded] = useState(expand);
  if (wasExpanded !== expand) {
    setWasExpanded(expand);
    set(expand);
  }

  const [datesOpen, { open: openDates, close: closeDates, toggle: toggleDates }] =
    useDisclosure(false);
  // Hover only where hovering is real: a tap synthesises mouseenter and
  // mouseleave around its click, and binding them unconditionally lets
  // the mouseleave close what the click just opened.
  const hoverable = typeof window !== "undefined"
    && window.matchMedia?.("(hover: hover)").matches === true;
  const dateHover = hoverable
    ? { onMouseEnter: openDates, onMouseLeave: closeDates }
    : {};

  const now = Date.now();
  const upcoming = scheduled(campaign.startsAt, now);
  const status = badge(campaign.status, campaign.startsAt, campaign.endsAt, now);
  const count = campaign.drops.length;
  const over = campaign.endsAt !== null && campaign.endsAt <= now;
  const elapsed = elapsedPercent(campaign.startsAt, campaign.endsAt, now);
  const { claimed, obtainable } = claimedCount(campaign.drops);
  const time = watchTime(campaign.drops);
  const marks = time === null
    ? []
    : milestones(campaign.drops, time.required);
  const dates = windowLines(campaign.startsAt, campaign.endsAt, now);
  const all = rewards(campaign.drops);
  const shown = all.slice(0, ICON_CAP);
  const extra = all.length - shown.length;
  // The title is the game where there is one. A campaign whose game the
  // source did not report falls back to its own name rather than
  // rendering an empty heading.
  const title = campaign.game?.displayName ?? campaign.name;

  return (
    // The id is what the subscriptions panel links down to. On the card
    // rather than on a wrapper, so the browser scrolls the whole card
    // into view and the drops that open below it are already on screen.
    <Card withBorder padding="sm" id={`campaign-${campaign.id}`}
          className={classes.card} data-testid="campaign-card">
      <Group align="flex-start" wrap="nowrap" gap="sm">
        <CampaignBoxArt
          url={campaign.game?.boxArtUrl}
          displayName={title}
          slug={campaign.game?.slug}
        />

        {/* minWidth 0 lets the long names inside actually clamp: a flex
            child defaults to its content's width and would otherwise
            push the card wider than its grid track. */}
        <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
          <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text fw={700} size="sm" lineClamp={1} data-testid="campaign-game">
                {title}
              </Text>
              <Text size="xs" c="dimmed" lineClamp={1} data-testid="campaign-name">
                {campaign.name}
              </Text>
            </Stack>
            {/* Either date is enough to say something true: a campaign
                with only a start still counts down to it, and one with
                only an end still reports its deadline. */}
            {(campaign.endsAt !== null
              || (upcoming && campaign.startsAt !== null)) && (
              /* A Popover rather than a Tooltip, for the reason
                 DropBadge and StreamContext use one: a tooltip opens on
                 hover only, so on a phone the exact dates -- the whole
                 point of the panel -- were unreachable. */
              <Popover
                opened={datesOpen}
                onDismiss={closeDates}
                position="bottom-end"
                withArrow
                shadow="md"
                disabled={dates.rows.length === 0}
              >
                <Popover.Target>
                  <UnstyledButton
                    {...dateHover}
                    onClick={toggleDates}
                    aria-expanded={datesOpen}
                    aria-label={`${campaign.name} campaign window`}
                    className={classes.countdown}
                    data-ended={over ? "" : undefined}
                    data-testid="campaign-ends"
                  >
                    {/* Three tenses, and the wrong one is a claim about
                        what you can earn right now. A campaign that has
                        not opened counts down to its start -- reporting
                        its deadline instead reads as time you could be
                        earning it. Past tense once the window has shut:
                        a finished campaign is not "ending in -2d". */}
                    {over
                      ? "ended"
                      : upcoming && campaign.startsAt !== null
                        ? `starts in ${formatSpan(campaign.startsAt - now)}`
                        : campaign.endsAt !== null
                          ? `${formatSpan(campaign.endsAt - now)} left`
                          : null}
                  </UnstyledButton>
                </Popover.Target>
                <Popover.Dropdown data-testid="campaign-window">
                  {/* Label and value as two columns, set in the theme's
                      own type rather than padded into alignment: the
                      dimmed label carries the distinction, so the dates
                      line up without a monospace trick. */}
                  <Stack gap={4}>
                    {dates.rows.map((row) => (
                      <Group key={row.label} gap="sm" wrap="nowrap"
                             justify="space-between">
                        <Text size="xs" c="dimmed">{row.label}</Text>
                        <Text size="xs" fw={500}>{row.value}</Text>
                      </Group>
                    ))}
                    {/* Set apart from the dates above it: those are the
                        facts, this is the same window read back
                        relative to now. On the dates' own 4px rhythm it
                        reads as a third date. */}
                    {dates.state !== null && (
                      <Text size="xs" c="dimmed" mt={4}
                            data-testid="campaign-window-state">
                        {dates.state}
                      </Text>
                    )}
                  </Stack>
                </Popover.Dropdown>
              </Popover>
            )}
          </Group>

          {/* The rewards at a glance. Capped rather than wrapped: an
              uncapped row on a ten-drop campaign sets that card taller
              than its neighbours and breaks the grid's rhythm. */}
          {shown.length > 0 && (
            <Group gap={4} wrap="nowrap" data-testid="reward-strip">
              {shown.map((benefit, at) => (
                <RewardIcon
                  key={`${benefit.name}-${at}`}
                  name={benefit.name}
                  imageUrl={benefit.imageUrl}
                  size={26}
                />
              ))}
              {extra > 0 && (
                <Text size="xs" c="dimmed" data-testid="reward-overflow">
                  +{extra}
                </Text>
              )}
            </Group>
          )}

          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text size="xs" c="dimmed" lineClamp={1} data-testid="campaign-owner">
              {campaign.owner?.name ?? `${count === 1 ? "1 drop" : `${count} drops`}`}
            </Text>
            <Badge
              size="sm"
              color={status.colour}
              variant="light"
              data-testid="campaign-status"
            >
              {status.label}
            </Badge>
          </Group>

          {/* Two bars, measuring two different things. Yours on top in
              the orange the app already uses for progress; the campaign's
              window under it, thinner and dimmer, because it is context
              rather than an achievement. Stacked rather than merged: one
              bar carrying both would be readable as neither. */}
          <Stack gap={3} mt={2}>
            {/* One track, two segments, both measured in minutes.
                Teal is banked -- the watch time already converted into
                claimed drops -- and orange is the watching done since,
                which the drop-count bar alone could not show: forty
                minutes into a sixty-minute drop looked identical to
                having just started it.

                Drawn in minutes rather than by drop count because the
                drops are cumulative thresholds of wildly different size:
                on a 15/30/45/60/120 campaign, equal slices would price
                the two-hour finale the same as the quarter hour. */}
            {time !== null && campaign.status !== "unknown" && (
              <Tooltip
                label={
                  `${time.watched} of ${time.required} minutes watched`
                  + ` · ${claimed} of ${obtainable} drops claimed`
                }
              >
                <Progress.Root
                  size="sm"
                  data-testid="campaign-progress"
                  aria-label={
                    `${campaign.name}: ${time.watched} of ${time.required}`
                    + ` minutes watched, ${claimed} of ${obtainable} drops claimed`
                  }
                >
                  <Progress.Section
                    value={(time.claimed / time.required) * 100}
                    color="teal"
                    data-testid="seg-claimed"
                  />
                  {/* Only the span BEYOND the claimed point, since the
                      sections stack: passing the full watched figure
                      would draw it twice and overflow the track. Omitted
                      entirely at zero, which would otherwise leave a
                      hairline of colour at the boundary. */}
                  {time.watched > time.claimed && (
                    <Progress.Section
                      value={((time.watched - time.claimed) / time.required) * 100}
                      color="orange"
                      data-testid="seg-watched"
                    />
                  )}
                  {/* The drop thresholds, drawn over the segments.
                      Absolutely positioned inside the track rather than
                      added as sections, because a section consumes width
                      and would push the coloured spans out of place --
                      these mark the scale, they are not part of it. */}
                  {marks.map((at) => (
                    <div
                      key={at}
                      className={classes.tick}
                      style={{ left: `${at}%` }}
                      data-testid="drop-tick"
                      aria-hidden
                    />
                  ))}
                </Progress.Root>
              </Tooltip>
            )}
            {elapsed !== null && (
              <Tooltip
                label={over ? "this campaign has ended" : `${Math.round(elapsed)}% of the campaign window has passed`}
              >
                <Progress
                  value={elapsed}
                  color="gray"
                  size={4}
                  data-testid="campaign-elapsed"
                  aria-label={`${campaign.name}: ${Math.round(elapsed)}% of the window elapsed`}
                />
              </Tooltip>
            )}
          </Stack>
        </Stack>
      </Group>

      {busy !== undefined && (
        <Group gap="xs" wrap="nowrap" mt="xs" data-testid="campaign-busy">
          <Loader size="xs" />
          <Text size="xs" c="dimmed">{busy}</Text>
        </Group>
      )}

      {/* The two controls sit below the card body rather than inside it:
          nesting the subscribe button within the disclosure button is
          invalid markup and leaves a keyboard user no way to reach it. */}
      <Group wrap="nowrap" gap="xs" mt="xs" align="center">
        <UnstyledButton
          onClick={toggle}
          aria-expanded={open}
          aria-label={`${campaign.name}, ${count} ${count === 1 ? "drop" : "drops"}`}
          className={classes.disclosure}
        >
          <Group gap={4} wrap="nowrap">
            <Text size="xs" c="dimmed" data-testid="campaign-drop-count">
              {count === 1 ? "1 drop" : `${count} drops`}
            </Text>
            <IconChevronDown
              size={14}
              style={{ transform: open ? "rotate(180deg)" : undefined }}
              aria-hidden
            />
          </Group>
        </UnstyledButton>

        {/* Twitch's drops page, beside the disclosure rather than on the
            title: the card spends its purple on the time left and on
            Subscribe, and a third coloured anchor would leave none of
            them meaning anything. Grey and icon-only at rest, lifting to
            full contrast on hover.

            The list, not this campaign, and it cannot be otherwise:
            Twitch renders every campaign as one accordion on a single
            client-side route, with no per-campaign anchor and no id in
            any href. A ?dropID=<id> query is preserved in the URL bar
            and ignored -- the page answers 200 for a fabricated id just
            as readily -- so it must not be mistaken for a deep link. The
            label says "your Twitch drops" because that is where the
            click lands. */}
        <Tooltip label="Open your drops on Twitch">
          <Anchor
            href="https://www.twitch.tv/drops/campaigns"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Your Twitch drops"
            className={classes.outLink}
            data-testid="campaign-link"
          >
            <IconExternalLink size={14} aria-hidden />
          </Anchor>
        </Tooltip>

        {/* No explicit colour: the theme's primary is Twitch purple, so
            subscribing inherits the brand, leaving orange to mean "drop
            in progress" on the badge beside it. Subscribed goes neutral,
            unsubscribing not being an action to encourage. */}
        {onSubscribe !== undefined && (
          <Button
            size="compact-xs"
            ml="auto"
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

      <Collapse expanded={open} keepMounted={false}>
        <div className={classes.gallery}>
          {campaign.drops.map((drop) => (
            <DropTile
              key={drop.id}
              drop={drop}
              campaignStartsAt={campaign.startsAt}
              campaignEndsAt={campaign.endsAt}
            />
          ))}
        </div>
      </Collapse>
    </Card>
  );
}
