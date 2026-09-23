import {
  Alert, Button, Group, Select, SimpleGrid, Stack, Switch, Text, UnstyledButton,
} from "@mantine/core";
import { IconCoins, IconUserFilled } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useLiveState } from "../api/useLiveState.js";
import { EventsFeed } from "../components/EventsFeed.js";
import { StalenessBadge } from "../components/StalenessBadge.js";
import { StatTile } from "../components/StatTile.js";
import tileClasses from "../components/StatTile.module.css";
import { StreamerCard } from "../components/StreamerCard.js";
import { SORT_KEYS, SORT_LABELS, sortStreamers, type SortKey } from "../lib/sortStreamers.js";
import { useLocalChoice } from "../lib/useLocalChoice.js";
import { useLocalToggle } from "../lib/useLocalToggle.js";
import classes from "./Dashboard.module.css";

const nf = new Intl.NumberFormat("en-US");

/**
 * Ties the visible "Sort" label to the Select's own input.
 *
 * A fixed id rather than `useId`: Mantine's Select puts this on the
 * element the label must point at, and the dashboard mounts once, so
 * there is no second instance to collide with.
 */
const SORT_INPUT_ID = "dashboard-sort";

/**
 * The narrowest a streamer card may get before another column is added.
 *
 * Fixed column counts per viewport breakpoint were wrong here: the grid
 * sits inside the main area, which is a navbar and two paddings narrower
 * than the window, so a viewport-keyed breakpoint decides the column
 * count from a number ~280px larger than the space being divided. It
 * fired `xl` (3 columns) at a 1408px window, dropping each card from
 * 554px to 365px -- widening the browser made the cards shrink.
 *
 * `auto-fill` against the grid's real width has no such gap: a column is
 * added only once one actually fits, so card width stays inside a band
 * instead of collapsing at a threshold. It also caps the single-column
 * case, which used to stretch one card to 700px of mostly empty row.
 */
const CARD_MIN_WIDTH = 320;

/**
 * A section rule.
 *
 * The heading sits closer to the cards it labels than to the section
 * above it, so it groups downward rather than floating between the two.
 * The asymmetry is what does that, and it is smaller than it looks from
 * the props: this renders inside a `Stack gap="md"`, so the 16px `mt`
 * lands on top of the Stack's own 16px for 32px of real space above,
 * against the 10px `mb` below.
 *
 * `mt` was `xl`, which made that 48px above and read as a gap in the
 * page rather than a division within it.
 *
 * Passing `collapsed` turns the whole rule into the section's disclosure
 * control. The heading already carries the count, so a collapsed section
 * still reports how many streamers it holds -- no separate "12 hidden"
 * label, and no risk of an empty section reading as an empty roster.
 */
function SectionHeading({ children, testId, collapsed, onToggle }: {
  children: string;
  testId?: string;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const label = (
    <>
      <Text
        size="xs" fw={700} c="dimmed"
        style={{ letterSpacing: "0.1em", whiteSpace: "nowrap" }}
      >
        {children}
      </Text>
      <div style={{ flex: 1, height: 1, background: "var(--tw-border)" }} />
    </>
  );

  if (!onToggle) {
    return (
      <Group gap="sm" wrap="nowrap" mt="md" mb="xs" data-testid={testId}>
        {label}
      </Group>
    );
  }

  return (
    <UnstyledButton
      onClick={onToggle}
      data-testid={testId}
      aria-expanded={!collapsed}
      mt="md" mb="xs"
      style={{ display: "block", width: "100%" }}
    >
      <Group gap="sm" wrap="nowrap">
        {/* A caret rather than a chevron icon: the app pulls in no icon
            set, and a rotated glyph costs nothing to ship. */}
        <Text
          size="xs" c="dimmed" aria-hidden
          style={{
            display: "inline-block",
            transition: "transform 150ms ease",
            transform: collapsed ? "rotate(-90deg)" : "none",
          }}
        >
          ▾
        </Text>
        {label}
      </Group>
    </UnstyledButton>
  );
}

export function Dashboard({ loginRequired = false, onSignIn, onOpenStreamer }: {
  loginRequired?: boolean;
  onSignIn?: () => void;
  /** Opens a streamer's detail dialog, which the shell hosts. */
  onOpenStreamer?: (login: string) => void;
} = {}) {
  const { snapshot, loadError } = useLiveState();
  const openDetail = (login: string) => onOpenStreamer?.(login);
  const [feedOn, toggleFeed] = useLocalToggle("dashboard.feed", true);
  // Offline streamers are the bulk of a big roster and the least
  // interesting part of it, so they start shown but collapse away.
  const [offlineOn, toggleOffline] = useLocalToggle("dashboard.offline", true);
  // One choice drives both sections. Per-section controls would have to
  // live in the headings, and the offline heading is already a button --
  // nesting a menu inside it is both an a11y problem and an easy misclick.
  const [sort, setSort] = useLocalChoice<SortKey>("dashboard.sort", "default", SORT_KEYS);

  /**
   * Without a working Twitch cookie the miner collects nothing, so this
   * is a blocking condition rather than advice -- hence no dismiss
   * control: hiding it would hide the reason the numbers stopped moving.
   *
   * The sidebar's dot on the account row says the same thing, but it is
   * an unlabelled circle: fine as a reminder for someone who knows what
   * it means, useless to a first-time user staring at an empty dashboard.
   */
  const notice = loginRequired && (
    <Alert
      role="alert"
      color="twitch"
      title="Twitch sign-in needed"
      data-testid="login-required-notice"
    >
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm">
          The miner cannot collect channel points until you connect a Twitch account.
        </Text>
        {onSignIn && (
          <Button size="xs" onClick={onSignIn}>Sign in to Twitch</Button>
        )}
      </Group>
    </Alert>
  );

  // Every return below wraps its body in the same <Stack>, notice first.
  // Not cosmetic: returning the notice bare here and nested once the
  // snapshot lands puts it at a different position in the element tree,
  // so React unmounts and remounts it instead of leaving it alone --
  // which flickers the alert the moment the first snapshot arrives.
  const frame = (children: ReactNode) => (
    <Stack gap="md">
      {notice}
      {children}
    </Stack>
  );

  // Guarded after the notice is built, not before: on a fresh install
  // there is no snapshot to show, and a user who has never signed in
  // would otherwise get a blank screen -- exactly the person this notice
  // exists for.
  if (!snapshot) {
    return frame(
      <>
        {loadError && (
          <Alert role="alert" color="red">
            Failed to load dashboard: {loadError}
          </Alert>
        )}
        {/* The tiles' own labels are fixed text, so the row can show what
            the page will hold while only the figures wait. A blank screen
            for the first seconds reads as an app with nothing in it. */}
        <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
          <StatTile loading label="Total points" value="" testId="total-points" />
          <StatTile loading label="24h gain" value="" accent="success" testId="stat-24h" />
          <StatTile loading label="Live now" value="" accent="live" testId="stat-live" />
          <StatTile loading label="Tracked" value="" testId="stat-tracked" />
        </SimpleGrid>
      </>,
    );
  }

  const total = snapshot.streamers.reduce((sum, s) => sum + (s.points ?? 0), 0);
  // Sorted after the split, not before: "recently live" reads a different
  // field on each side (a live channel has no lastLive, an offline one no
  // liveSince), and the grouping is the dashboard's primary claim anyway.
  const live = sortStreamers(snapshot.streamers.filter((s) => s.isOnline), sort, "live");
  // Streamers already shown above under "Live now" are omitted here so a
  // live streamer's points aren't rendered twice in the same view.
  const others = sortStreamers(
    snapshot.streamers.filter((s) => !s.isOnline), sort, "offline",
  );

  // null stays null until at least one streamer has a baseline, for the
  // same reason the total does: "nothing earned" and "nothing known yet"
  // are different claims.
  const gained = snapshot.streamers.reduce<number | null>((sum, s) => {
    if (s.gained24h === null) return sum;
    return (sum ?? 0) + s.gained24h;
  }, null);

  // A streamer tracked for two hours contributes a two-hour gain to a
  // figure labelled "24h". That is worth showing -- it is real earning --
  // but the tile must say so, or the sum quietly overstates its window.
  const partial = snapshot.streamers.some(
    (s) => s.gained24h !== null && s.gainedSince !== null,
  );

  // A real 0 (every tracked streamer genuinely has none) and "we have not
  // looked yet" must never render the same way -- the latter used to show
  // a confident "0" for a full refresh interval after every restart,
  // beside a badge nobody reads closely enough to notice contradicts it.
  const totalText = snapshot.lastUpdated === null ? "—" : nf.format(total);
  const gainedText = gained === null
    ? "—"
    : `${gained > 0 ? "+" : ""}${nf.format(gained)}`;

  const cards = (
    <>
      <SectionHeading testId="live-heading">{`LIVE NOW · ${live.length}`}</SectionHeading>
      <SimpleGrid minColWidth={CARD_MIN_WIDTH} spacing="md">
        {live.map((s) => (
          <StreamerCard
            key={s.username}
            streamer={s}
            onOpen={() => openDetail(s.username)}
          />
        ))}
      </SimpleGrid>

      <SectionHeading
        testId="offline-heading"
        collapsed={!offlineOn}
        onToggle={toggleOffline}
      >
        {`OFFLINE · ${others.length}`}
      </SectionHeading>
      {offlineOn && (
        <SimpleGrid minColWidth={CARD_MIN_WIDTH} spacing="md">
          {others.map((s) => (
            <StreamerCard
              key={s.username}
              streamer={s}
              onOpen={() => openDetail(s.username)}
            />
          ))}
        </SimpleGrid>
      )}
    </>
  );

  return frame(
    <>
      {/* One strip, not three widgets. `align="center"` rather than the
          default stretch so the freshness caption sits on the controls'
          own centre line -- it is an 11px caption beside a 30px select,
          and left to stretch it floated against the top of the row. The
          switch is sized down to `xs` to match: a caption, a select and a
          switch at three different scales was most of why this row read
          as unrelated parts. */}
      <Group justify="space-between" align="center" wrap="wrap" gap="sm">
        <StalenessBadge
          lastUpdated={snapshot.lastUpdated}
          stale={snapshot.stale}
          pending={snapshot.pending}
        />
        <Group gap="sm" align="center" wrap="nowrap">
          {/* The control sorts the cards below, and nothing on screen used
              to say so -- a bare dropdown reading "Default" beside a
              freshness caption could as easily have been filtering the
              roster or picking a time window. The label is the fix, and
              it takes the caption's own type so the strip still reads as
              one row rather than acquiring a third scale. */}
          <Text className={classes.sortLabel} component="label" htmlFor={SORT_INPUT_ID}>
            Sort
          </Text>
          <Select
            id={SORT_INPUT_ID}
            data={SORT_KEYS.map((key) => ({ value: key, label: SORT_LABELS[key] }))}
            value={sort}
            onChange={(value) => value !== null && setSort(value as SortKey)}
            // A sort must always be *some* ordering: clearing the value
            // would leave the grid in an order the control no longer names.
            allowDeselect={false}
            aria-label="Sort streamers"
            data-testid="sort-control"
            size="xs"
            // Fits the longest label ("Recently live") plus the chevron.
            w={150}
          />
          <Switch
            checked={feedOn}
            onChange={toggleFeed}
            label="Activity feed"
            size="xs"
          />
        </Group>
      </Group>

      {snapshot.error && <Alert role="alert" color="orange">{snapshot.error}</Alert>}

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        {/* The row mixes units: the first two tiles count points, the
            last two count channels. The glyphs say which is which at a
            glance -- the coin rhymes with the card balances below, the
            person with their viewer counts. Gold on the coin rather than
            the tile's accent, so it matches the cards exactly.

            The 24h gain deliberately carries no coin: its green rule,
            its "+" and the word "gain" already mark it three times over,
            and a coin on exactly one points tile reads as marking THE
            headline figure rather than making two mismatched pairs. */}
        <StatTile
          label="Total points"
          value={totalText}
          icon={<IconCoins className={tileClasses.coin} stroke={2} aria-hidden />}
          testId="total-points"
        />
        <StatTile
          label="24h gain"
          value={gainedText}
          hint={partial && gained !== null ? "partial · some tracked <24h" : undefined}
          accent="success"
          testId="stat-24h"
        />
        <StatTile
          label="Live now"
          value={String(live.length)}
          icon={<IconUserFilled className={tileClasses.icon} aria-hidden />}
          accent="live"
          testId="stat-live"
        />
        <StatTile
          label="Tracked" value={String(snapshot.streamers.length)}
          icon={<IconUserFilled className={tileClasses.icon} aria-hidden />}
          testId="stat-tracked"
        />
      </SimpleGrid>

      {cards}

      {/* Full width beneath the cards rather than a side column: the
          miner's own log lines are long, and a narrow column truncated
          almost every one of them. */}
      <EventsFeed enabled={feedOn} />
    </>,
  );
}
