import {
  ActionIcon, Alert, Anchor, Button, Card, Group, Loader, NumberInput, Stack,
  Text, TextInput, Tooltip,
} from "@mantine/core";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter,
  useSensor, useSensors, type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  IconAlertTriangle, IconExternalLink, IconGripVertical, IconRefresh, IconSearch,
} from "@tabler/icons-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { CampaignCard, type ResolvedCampaign } from "../components/CampaignCard.js";
import { formatSpan } from "../lib/formatSpan.js";
import classes from "./Drops.module.css";

/** A subscription as the API reports it, with its resolved channels. */
export interface SubscriptionRow {
  id: string;
  kind: "campaign" | "game";
  targetId: string;
  label: string;
  poolSize: number;
  rank: number;
  /** Logins the engine currently has in the config for this one. */
  channels: string[];
}

export interface CampaignsPayload {
  campaigns: ResolvedCampaign[];
  /** Epoch ms the campaign list was fetched. */
  catalogueFetchedAt: number;
  /** The list could not be refreshed; what is shown is older than its TTL. */
  catalogueStale: boolean;
  /** False when the campaign list could not be read at all. */
  catalogueAvailable: boolean;
  /** Why the last fetch failed, when it did. */
  catalogueError: string | null;
  /** Epoch ms the progress was fetched. */
  progressFetchedAt: number;
  /** False when the inventory could not be read at all. */
  progressAvailable: boolean;
}

/**
 * Where the campaign list comes from, shown on the page.
 *
 * Not Twitch: their own campaign query is behind bot detection and
 * cannot be reached from a script (see campaignSource.ts). The user is
 * told because it explains why this list can differ from
 * twitch.tv/drops/campaigns, and because a page presenting someone
 * else's data as Twitch's own would misrepresent both.
 */
const SOURCE_NAME = "Fenrisapps Twitch Drops Tracker";
const SOURCE_HREF = "https://twitch-drops.fenrisapps.com/";

/**
 * Which slice of the catalogue the grid shows.
 *
 * `unclaimed` is the one the tracker has no equivalent for: it needs
 * this viewer's inventory, which a public site does not have.
 */
type View = "all" | "running" | "scheduled" | "unclaimed" | "collected";

const VIEWS: { value: View; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running now" },
  { value: "scheduled", label: "Scheduled" },
  { value: "unclaimed", label: "Unclaimed" },
  // The inverse of Unclaimed, and the only view that surfaces what has
  // actually been earned: every other pill either buries it at the
  // bottom or leaves it out.
  { value: "collected", label: "Collected" },
];

/** What the empty grid says, per view -- each a claim about that view. */
const EMPTY: Record<View, string> = {
  all: "No drop campaigns are running.",
  running: "No campaigns are running right now.",
  scheduled: "No campaigns are scheduled.",
  unclaimed: "Nothing left to claim -- every campaign here is done.",
  collected: "Nothing collected yet.",
};

/** Whether a campaign's window has yet to open. */
function isScheduled(c: ResolvedCampaign, now: number): boolean {
  return c.startsAt !== null && c.startsAt > now;
}

/** Whether a campaign's window has shut. */
function hasEnded(c: ResolvedCampaign, now: number): boolean {
  return c.endsAt !== null && c.endsAt <= now;
}

/**
 * Whether a campaign belongs in the given view.
 *
 * `unclaimed` excludes the ended as well as the collected: progress on
 * an expired campaign is frozen and can never be finished, so listing it
 * as something still to claim would be a promise the page cannot keep.
 * A campaign whose progress could not be read stays in -- "unknown" is
 * not "nothing left to do".
 */
function inView(c: ResolvedCampaign, view: View, now: number): boolean {
  switch (view) {
    case "running":
      return !isScheduled(c, now) && !hasEnded(c, now);
    case "scheduled":
      return isScheduled(c, now);
    case "unclaimed":
      return !hasEnded(c, now) && c.status !== "collected";
    // Ended ones included, unlike Unclaimed: a campaign collected before
    // it closed is still collected, and this is the view for reviewing
    // what was earned rather than what is left to do.
    case "collected":
      return c.status === "collected";
    case "all":
      return true;
  }
}

/**
 * "3h ago", or "just now" below a minute -- a zero span reads as broken.
 *
 * Null when the cache has never been filled. Both timestamps start at 0
 * and only advance on a successful fetch, so a miner with no Twitch
 * session reported its progress as "20715d ago" -- the epoch, formatted
 * as though the inventory had genuinely been read once, in 1970. "Never"
 * is the honest answer, and it is a different claim from an old one.
 */
function age(at: number): string | null {
  if (at <= 0) return null;
  const delta = Date.now() - at;
  return delta < 60_000 ? "just now" : `${formatSpan(delta)} ago`;
}

/** Whether a campaign's own name or its game contains the needle. */
function matchesHeader(c: ResolvedCampaign, needle: string): boolean {
  return c.name.toLowerCase().includes(needle)
    || (c.game?.displayName.toLowerCase().includes(needle) ?? false);
}

/** Whether any drop inside the campaign contains the needle. */
function matchesDrop(c: ResolvedCampaign, needle: string): boolean {
  return c.drops.some((d) => d.name.toLowerCase().includes(needle));
}

/**
 * Whether the only reason this campaign survived the filter is a drop.
 *
 * Such a card is opened, because everything on the collapsed row -- name,
 * game, deadline -- lacks what was typed, and a result that does not
 * visibly contain the search term reads as a bug. A campaign matched by
 * its own name or game is left alone: the match is already on the row,
 * and opening it would spend a screenful to show nothing new.
 */
function matchedByDropOnly(c: ResolvedCampaign, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return false;
  return !matchesHeader(c, needle) && matchesDrop(c, needle);
}

/**
 * Where a subscription's label points, or null when nowhere real does.
 *
 * A campaign still in the catalogue links down to its own card on this
 * same page, which is the only place showing this viewer's progress
 * against its drops -- the panel itself lists none of that, and neither
 * does any page elsewhere. (The tracker does publish a page per
 * campaign, at /campaigns/<id>; it just cannot know what you have
 * claimed.)
 *
 * Otherwise the game's Twitch directory, which is where the channels in
 * the row came from. That covers a `game` subscription, which is tied to
 * no campaign at all, and a campaign that has since left the catalogue.
 * A campaign whose game is unknown gets no link rather than a guessed
 * one: a slug invented from a display name lands on a 404.
 */
function subscriptionLink(
  sub: SubscriptionRow,
  campaigns: ResolvedCampaign[],
): { href: string; external: boolean } | null {
  if (sub.kind === "campaign") {
    const campaign = campaigns.find((c) => c.id === sub.targetId);
    if (campaign !== undefined) {
      return { href: `#campaign-${campaign.id}`, external: false };
    }
  }
  const slug = campaigns.find(
    (c) => c.game?.id === sub.targetId,
  )?.game?.slug;
  if (slug === undefined || slug === "") return null;
  return {
    href: `https://twitch.tv/directory/category/${slug}`,
    external: true,
  };
}

/**
 * The game a subscription is for, or null when there is nothing to add.
 *
 * Looked up in the catalogue the page already holds rather than added to
 * the subscriptions payload: the engine stores a label and a target id,
 * and the game is a property of the campaign, not of the subscription.
 *
 * Returns null when the name would only repeat the label -- a game
 * subscription is labelled with its game, and rendering it twice on one
 * row reads as a rendering fault rather than as detail. Also null for a
 * campaign that has left the catalogue, where there is nothing to look
 * up and a guess would be worse than silence.
 */
function subscriptionGame(
  sub: SubscriptionRow,
  campaigns: ResolvedCampaign[],
): string | null {
  const game = sub.kind === "campaign"
    ? campaigns.find((c) => c.id === sub.targetId)?.game
    : campaigns.find((c) => c.game?.id === sub.targetId)?.game;
  const name = game?.displayName;
  if (name === undefined || name === "") return null;
  return name.toLowerCase() === sub.label.toLowerCase() ? null : name;
}

/**
 * One subscription in the panel, draggable by its grip.
 *
 * Rank decides which subscriptions fill the miner's watch slots first, so
 * the position is shown rather than merely implied: an unnumbered list
 * reads as decoration, and this order is the thing that picks what gets
 * watched.
 *
 * `draggable` is false for a lone subscription -- there is nothing to
 * reorder against, and a grip that cannot do anything is a promise the
 * panel does not keep.
 */
function SubscriptionRow({
  sub, index, draggable, restartPending, busy, link, game, onOpen, onRemove,
  onPoolSize,
}: {
  sub: SubscriptionRow;
  index: number;
  draggable: boolean;
  restartPending: boolean;
  busy: boolean;
  /** The game this is for, or null when naming it would add nothing. */
  game: string | null;
  /** Where the label points, or null when nothing real to point at. */
  link: { href: string; external: boolean } | null;
  /** Called when an in-page link is followed, to open the card landed on. */
  onOpen: () => void;
  onRemove: () => void;
  onPoolSize: (size: number) => void;
}) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform,
    transition, isDragging,
  } = useSortable({ id: sub.id, disabled: !draggable });
  /**
   * What is in the box, which is not yet what is in force.
   *
   * Held locally so the digits can be edited freely -- half a number is
   * a legal thing to have typed and an illegal thing to save. It is
   * committed on blur or Enter rather than per keystroke: each commit
   * costs a directory resolve and may propose a restart, so typing "6"
   * over "3" must not first ask the engine for a pool of one.
   */
  const [draft, setDraft] = useState<string | number>(sub.poolSize);
  useEffect(() => { setDraft(sub.poolSize); }, [sub.poolSize]);

  function commit() {
    const size = Number(draft);
    // An emptied box is not a request for zero channels; it falls back
    // to the size actually in force rather than posting something the
    // server would reject.
    if (!Number.isInteger(size) || size < 1 || size > 10) {
      setDraft(sub.poolSize);
      return;
    }
    if (size === sub.poolSize) return;
    onPoolSize(size);
  }

  return (
    <Group
      ref={setNodeRef}
      data-testid="subscription-row"
      justify="space-between"
      // Wrapping is what lets the controls drop below the text on a
      // narrow screen; the CSS decides when, this only permits it.
      wrap="wrap"
      className={classes.subRow}
      gap="xs"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // The lifted row rides above its neighbours as they slide under it.
        zIndex: isDragging ? 1 : undefined,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: "1 1 260px" }}>
        {draggable && (
          <ActionIcon
            variant="subtle"
            color="gray"
            ref={setActivatorNodeRef}
            aria-label={`Reorder ${sub.label}`}
            style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
            {...attributes}
            {...listeners}
          >
            <IconGripVertical size={16} />
          </ActionIcon>
        )}
        <Text size="sm" c="dimmed" ff="monospace" w={16}>{index + 1}</Text>
        <div style={{ minWidth: 0 }}>
          {/* The panel lists no drops of its own, so the label is the way
              to somewhere that does. Plain text when there is nowhere to
              go: a link that lands on nothing is worse than no link.

              The game rides alongside rather than on its own line: many
              campaign names are a bare version string ("J5 - Temporix
              Cps") that says nothing about what game they belong to, and
              the row has the width to spare. Dimmed, because the label
              is what the row is identified by. */}
          <Group gap={6} wrap="nowrap" align="baseline" style={{ minWidth: 0 }}>
          {link === null ? (
            <Text size="sm" lineClamp={1}>{sub.label}</Text>
          ) : (
            <Anchor
              size="sm"
              lineClamp={1}
              href={link.href}
              // The in-page link stays in this tab -- it is a jump down
              // the page, and opening a second copy of the app to reach
              // a card already on screen is not what the click meant.
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noreferrer noopener" : undefined}
              // Expanding the card is the point: arriving at a collapsed
              // one shows nothing the panel did not already say. Only for
              // the in-page jump; there is no card to open otherwise.
              onClick={link.external ? undefined : onOpen}
            >
              {sub.label}
              {link.external && (
                <IconExternalLink
                  size={11}
                  style={{ marginLeft: 3, verticalAlign: "-1px" }}
                  aria-hidden
                />
              )}
            </Anchor>
          )}
          {game !== null && (
            <Text
              size="xs"
              c="dimmed"
              lineClamp={1}
              // Shrinks before the label does, which is what keeps the
              // campaign name whole on a narrow row -- the label is what
              // the row is identified by, and the game is the note
              // beside it.
              //
              // Width is yielded by shrinking, never by a cap: a share
              // of the row (maxWidth: 33%) is not a measure of whether
              // the text fits, and truncates long game names on a wide
              // screen with most of the row unused.
              style={{ flexShrink: 1000, minWidth: 0 }}
              data-testid="subscription-game"
            >
              {game}
            </Text>
          )}
          </Group>
          <Text size="xs" c="dimmed">
            {/* Three different states, and saying the wrong one
                is a claim about the miner that is not true:
                the engine looked and found nobody live, resolved
                but not watched until the pending restart lands,
                or genuinely being watched now.
                An empty pool is an answer, not a wait -- the
                engine resolves on subscribe, so "finding
                channels…" here would never resolve. */}
            {sub.channels.length === 0
              ? "nobody is streaming this right now"
              : (
                <>
                  {restartPending ? "after the restart: " : "watching "}
                  {/* The commas are rendered between the links rather
                      than joined into one string: a login is a place you
                      can go, and the separators are not part of it. */}
                  {sub.channels.map((login, at) => (
                    <Fragment key={login}>
                      {at > 0 && ", "}
                      <Anchor
                        size="xs"
                        href={`https://twitch.tv/${login}`}
                        // A new tab, because this page is a control panel
                        // with a live session behind it: navigating it
                        // away to glance at a channel loses that.
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        {login}
                      </Anchor>
                    </Fragment>
                  ))}
                </>
              )}
          </Text>
        </div>
      </Group>
      <Group gap={6} wrap="nowrap" className={classes.subControls}>
        {/* The number alone is a count of nothing in particular, so the
            unit is on the row and the reason behind it is a hover away.
            Both, rather than one: the word is what makes the control
            legible at a glance, and the tooltip is what explains why
            anyone would change it. */}
        <Tooltip
          label={
            "How many channels to keep resolved for this campaign. "
            + "More absorbs channels going offline between checks; "
            + "fewer leaves room for your other subscriptions."
          }
          multiline
          w={260}
        >
          <NumberInput
            size="xs"
            // Two digits and the stepper, no more. The arrows are hidden
            // until the control is hovered or focused, so a resting row
            // is the number and its unit rather than a pair of chevrons
            // repeated down the panel.
            w={48}
            min={1}
            max={10}
            clampBehavior="strict"
            aria-label={`Channels for ${sub.label}`}
            disabled={busy}
            value={draft}
            onChange={setDraft}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            classNames={{
              root: classes.poolField,
              input: classes.poolInput,
              controls: classes.poolStepper,
            }}
          />
        </Tooltip>
        <Text size="xs" c="dimmed">channels</Text>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          // Every Remove goes inert, not just the one clicked:
          // a second removal mid-flight would post against a
          // subscription the first call is already deleting.
          loading={busy}
          onClick={onRemove}
        >
          Remove
        </Button>
      </Group>
    </Group>
  );
}

/**
 * Every running drop campaign, with this viewer's progress against each.
 *
 * Filtering is client side: the whole catalogue is already here, a few
 * hundred rows at most, and a round trip per keystroke would make the
 * box feel worse for no gain.
 *
 * The two ages are reported separately because they come from caches a
 * day apart -- campaign metadata barely moves, progress does -- and one
 * combined figure would describe neither.
 */
export function Drops() {
  const [data, setData] = useState<CampaignsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<"progress" | "catalogue" | null>(null);
  const [filter, setFilter] = useState("");
  const [view, setView] = useState<View>("all");
  const [subs, setSubs] = useState<SubscriptionRow[]>([]);
  /**
   * What is running, and which campaign it belongs to.
   *
   * `key` is the campaign id whose row shows the notice, so the feedback
   * lands where the click did and cannot be mistaken for another
   * campaign's. Panel actions carry the campaign they act on, which is
   * what stops that campaign's card offering the same action twice.
   */
  const [busy, setBusy] = useState<{ key: string; label: string } | null>(null);
  // Whether a restart is waiting. Channels already resolved are not
  // being watched until it happens, and the panel must not claim
  // otherwise.
  const [restartPending, setRestartPending] = useState(false);
  /**
   * The campaign a subscription link jumped to, whose card is opened.
   *
   * One at a time: a second jump closes the first, so following two
   * links does not leave a trail of opened cards behind.
   */
  const [jumpedTo, setJumpedTo] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<CampaignsPayload>("/api/campaigns")
      .then((payload) => { if (live) { setData(payload); setError(null); } })
      .catch((cause: unknown) => {
        // Reported, not swallowed into an empty list: "no campaigns" and
        // "we could not ask" are different claims.
        if (live) setError(cause instanceof Error ? cause.message : "failed to load");
      });
    return () => { live = false; };
  }, []);

  async function loadSubs() {
    try {
      const res = await api.get<{ subscriptions?: SubscriptionRow[] }>(
        "/api/subscriptions",
      );
      // Guarded rather than trusted: a response without the field would
      // otherwise put undefined where an array is expected and take the
      // whole page down on the next render.
      setSubs(Array.isArray(res.subscriptions) ? res.subscriptions : []);
    } catch {
      // The campaign list is the page's job; a subscriptions panel that
      // cannot load must not take the whole screen down with it.
    }
  }

  useEffect(() => { void loadSubs(); }, []);

  // Read once on mount and refreshed after any mutation: the shell owns
  // the live SSE version for its banner, and this page only needs to
  // know whether the channels it lists are live yet.
  async function loadRestart() {
    try {
      const s = await api.get<{ pendingRestart?: { pending: boolean } }>(
        "/api/status",
      );
      setRestartPending(s.pendingRestart?.pending === true);
    } catch {
      // Leave it as it was; the wording degrades to the optimistic case.
    }
  }

  useEffect(() => { void loadRestart(); }, []);

  /**
   * Runs a subscription mutation, then re-reads the list it changed.
   *
   * `key` decides where the notice appears and `label` what it says.
   * Resolving asks Twitch for a game's live channels, which takes
   * seconds rather than milliseconds, so the wait needs saying.
   */
  async function mutate(key: string, label: string, run: () => Promise<unknown>) {
    setBusy({ key, label });
    try {
      await run();
      await loadSubs();
      await loadRestart();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "that did not work");
    } finally {
      setBusy(null);
    }
  }

  // An activation distance keeps a click on the grip from being read as a
  // drag; the keyboard sensor is the only reorder path for a keyboard user.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * Commits a drag to the server, optimistically.
   *
   * The rows move first: a row that springs back while the POST is in
   * flight reads as the drag having failed. A rejected call restores the
   * previous order rather than leaving an order up that the engine is not
   * using, which is the worse of the two lies.
   *
   * Not routed through `mutate`: that reloads the list on success, and
   * re-reading a freshly written order would only replace the rows with
   * identical ones. The restart state does need re-reading, because a new
   * rank order changes which channels the miner watches.
   */
  async function reorder({ active, over }: DragEndEvent) {
    if (over === null || active.id === over.id) return;
    const from = subs.findIndex((s) => s.id === active.id);
    const to = subs.findIndex((s) => s.id === over.id);
    if (from === -1 || to === -1) return;

    const previous = subs;
    const moved = arrayMove(subs, from, to);
    setSubs(moved);
    try {
      // The endpoint rejects anything short of the full set, which is
      // exactly what this list is.
      await api.post("/api/subscriptions/reorder", {
        ids: moved.map((s) => s.id),
      });
      await loadRestart();
    } catch (cause: unknown) {
      setSubs(previous);
      setError(cause instanceof Error ? cause.message : "could not reorder");
    }
  }

  /**
   * Refetches one half of the page, past its TTL.
   *
   * Split because the halves cost wildly different amounts: progress is
   * one query on a ten-minute clock, the catalogue a detail sweep over
   * every active campaign on a 24h one. Reloading both to answer "did my
   * minutes land?" spent the expensive half on data that had not moved.
   */
  async function refresh(what: "progress" | "catalogue") {
    setRefreshing(what);
    try {
      setData(await api.post<CampaignsPayload>(
        `/api/campaigns/refresh?what=${what}`,
      ));
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "refresh failed");
    } finally {
      setRefreshing(null);
    }
  }

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const now = Date.now();
    // The pills and the box narrow the same list, in that order: the
    // view picks the slice, the needle searches within it.
    const inScope = (data?.campaigns ?? []).filter((c) => inView(c, view, now));
    const matched =
      needle === "" || data === null
        ? inScope
        : inScope.filter((c) =>
            // Name, game or drop: the game is how most campaigns are
            // actually found, and the drop is often the only name the
            // player knows -- they are hunting a particular skin, not
            // whatever the campaign offering it is called. A separate box
            // per field would not earn its width.
            matchesHeader(c, needle) || matchesDrop(c, needle));

    // Five tiers, then soonest deadline within each.
    //
    //   1. Live, with progress on them -- watch time already committed
    //      outranks anything else, even something expiring sooner.
    //   2. Everything else live.
    //   3. Scheduled, sorted by when they open. Below everything live,
    //      because a campaign you cannot earn yet must not outrank one
    //      expiring tonight; above ended, because it is still to come.
    //   4. Collected. Nothing about it needs acting on ever again, so it
    //      sits below even a scheduled campaign -- which at least
    //      becomes actionable later. It used to rank in tier 2 by
    //      deadline, which scattered finished campaigns through the live
    //      ones and put a done campaign expiring tonight above an
    //      untouched one with a week left. Above ended rather than last,
    //      because the rewards are real and worth seeing.
    //   5. Ended, whatever progress sits on it, because that progress is
    //      frozen and can never be finished. Kept rather than hidden:
    //      the tracker still lists them and a drop already earned is
    //      worth seeing.
    //
    // Collected is tested before the live checks, so a collected
    // campaign sinks whether or not its window is still open -- the
    // whole point is that an open window no longer means anything for
    // it. Ended is tested first of all: frozen progress is not
    // actionable however complete it is.
    //
    // Within a tier: soonest deadline first, so 40/60 minutes expiring
    // tonight outranks 10/60 with a week left. Scheduled sorts on its
    // start instead -- the date that decides when it becomes actionable.
    // No date sorts after dated ones -- an unknown deadline is not an
    // urgent one -- and ties break by name so a refresh does not
    // reshuffle the list.
    const tier = (c: ResolvedCampaign) => {
      if (hasEnded(c, now)) return 4;
      if (c.status === "collected") return 3;
      if (isScheduled(c, now)) return 2;
      return c.status === "partial" ? 0 : 1;
    };
    return [...matched].sort((a, b) => {
      const byTier = tier(a) - tier(b);
      if (byTier !== 0) return byTier;
      const key = (c: ResolvedCampaign) =>
        (isScheduled(c, now) ? c.startsAt : c.endsAt) ?? Infinity;
      const byDate = key(a) - key(b);
      return byDate !== 0 ? byDate : a.name.localeCompare(b.name);
    });
  }, [data, filter, view]);

  if (error !== null && data === null) {
    return (
      <Alert color="red" icon={<IconAlertTriangle />} data-testid="campaigns-error">
        Could not load drop campaigns: {error}
      </Alert>
    );
  }

  if (data === null) return <Loader />;

  const catalogueAge = age(data.catalogueFetchedAt);
  const progressAge = age(data.progressFetchedAt);

  return (
    // Wider than the rest of the app: the campaigns below are a card
    // grid, and the cap is what decides how many fit per row -- 1400
    // gives three comfortable columns on a desktop and still stops the
    // rows growing long enough to lose your place on an ultrawide. The
    // old 900 existed to keep a full-width row's badge near its name, a
    // constraint a card does not have. The bottom padding clears the
    // pinned restart banner, which would otherwise half-cover the last
    // campaign.
    <Stack gap="md" maw={1400} pb={140}>
      {/* One row: the pills pick the slice, the box searches inside it,
          the refresh buttons reload it. The label is dropped from the input --
          with the pills beside it the row reads as one control group,
          and a floating "Filter" caption above only one of them puts
          them on different baselines. */}
      {/* The pills and the box are one control group, so they sit
          together on the left rather than being pushed to opposite ends
          of a 1400px row. The refresh buttons keep to the far right: they
          act on the whole page, not on the filters. */}
      <Group wrap="wrap" gap="sm" align="center">
        <Group gap={6} wrap="wrap">
          {VIEWS.map((v) => (
            <Button
              key={v.value}
              size="compact-sm"
              radius="xl"
              // Filled for the one in force, subtle for the rest: at a
              // glance the row has to say which slice is on screen, or
              // an empty grid reads as "no campaigns" rather than "none
              // in this view".
              variant={view === v.value ? "filled" : "subtle"}
              color={view === v.value ? undefined : "gray"}
              aria-pressed={view === v.value}
              onClick={() => setView(v.value)}
            >
              {v.label}
            </Button>
          ))}
        </Group>
        {/* Wide enough to read a campaign name back, capped so it does
            not stretch to the far edge of a 1400px page. */}
        <TextInput
            // The visible caption is gone, so the name is carried here:
            // a bare box with a placeholder announces nothing once text
            // is typed into it.
          aria-label="Filter"
          placeholder="Campaign, game or drop"
          leftSection={<IconSearch size={16} />}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          style={{ flex: "1 1 260px", maxWidth: 420 }}
        />
        {/* Pushed to the far right, away from the filters they do not
            belong to. Two buttons rather than one: progress moves every
            few minutes while you watch and costs a single query, where
            the campaign list is nearly static and costs a sweep over
            every active campaign. One button made the common press pay
            for the rare one.

            Progress leads and is the filled one -- "did my minutes
            land?" is what the page is reloaded for. Campaigns stays
            subtle beside it: useful when something has just been
            announced, and otherwise not worth reaching for. */}
        <Group gap="xs" ml="auto" wrap="nowrap">
          <Button
            leftSection={<IconRefresh size={16} />}
            onClick={() => void refresh("progress")}
            loading={refreshing === "progress"}
            disabled={refreshing !== null}
            data-testid="refresh-progress"
          >
            Refresh progress
          </Button>
          <Button
            variant="default"
            leftSection={<IconRefresh size={16} />}
            onClick={() => void refresh("catalogue")}
            loading={refreshing === "catalogue"}
            disabled={refreshing !== null}
            data-testid="refresh-catalogue"
          >
            Refresh campaigns
          </Button>
        </Group>
      </Group>

      <Group gap="md" wrap="wrap">
        <Text size="xs" c="dimmed" data-testid="catalogue-age">
          {catalogueAge === null
            ? "Campaigns never read"
            : `Campaigns updated ${catalogueAge}`}
        </Text>
        <Text size="xs" c="dimmed" data-testid="progress-age">
          {progressAge === null
            ? "Progress never read"
            : `Progress updated ${progressAge}`}
        </Text>
        <Text size="xs" c="dimmed" data-testid="catalogue-source">
          Campaigns from{" "}
          <Anchor
            href={SOURCE_HREF}
            target="_blank"
            rel="noreferrer noopener"
            size="xs"
          >
            {SOURCE_NAME}
            <IconExternalLink
              size={11}
              style={{ marginLeft: 3, verticalAlign: "-1px" }}
              aria-hidden
            />
          </Anchor>
          , not Twitch. Your progress comes from Twitch.
        </Text>
      </Group>

      {/* Unavailable outranks stale: when we have never read the list,
          saying it "may be missing campaigns" understates it -- there is
          nothing here at all, and the empty state below must not claim
          otherwise. */}
      {!data.catalogueAvailable ? (
        <Alert
          color="red"
          icon={<IconAlertTriangle />}
          data-testid="catalogue-unavailable"
        >
          The campaign list could not be loaded, so this page cannot say
          what is running. This usually means{" "}
          <Anchor href={SOURCE_HREF} target="_blank" rel="noreferrer noopener">
            {SOURCE_NAME}
          </Anchor>
          , which it reads campaigns from, changed or is down.
          {data.catalogueError !== null && (
            <Text size="xs" c="dimmed" mt={4}>{data.catalogueError}</Text>
          )}
        </Alert>
      ) : data.catalogueStale ? (
        <Alert color="yellow" data-testid="catalogue-stale">
          {/* Stale implies a successful earlier fetch, so the age is
              always known here -- but the sentence must not degrade into
              "announced since ." if that ever stops holding. */}
          {catalogueAge === null
            ? "This list could not be refreshed, so it may be missing campaigns."
            : `This list could not be refreshed, so it may be missing campaigns announced since ${catalogueAge}.`}
        </Alert>
      ) : null}

      {!data.progressAvailable && (
        <Alert color="yellow" data-testid="progress-unavailable">
          Your drop progress is unavailable right now, so these campaigns
          show what they award but not how far along you are.
        </Alert>
      )}

      {/* Only claims "none are running" when we actually know. With the
          list unavailable the banner above has already said why, and
          repeating a factual-sounding empty state under it would
          contradict it. */}
      {subs.length > 0 && (
        <Card withBorder padding="sm" data-testid="subscriptions">
          <Group justify="space-between" align="center" mb={4}>
            <Text fw={600} size="sm">Subscriptions</Text>
            <Button
              size="compact-xs"
              variant="default"
              loading={busy !== null}
              onClick={() => void mutate(
                "panel",
                "Re-checking channels…",
                () => api.post("/api/subscriptions/resolve"),
              )}
            >
              Re-resolve now
            </Button>
          </Group>
          {/* The cadence is otherwise invisible, and a page that looks
              static when it is not invites clicking Re-resolve to check. */}
          {busy !== null ? (
            <Group gap="xs" wrap="nowrap" mb="xs" data-testid="resolving">
              <Loader size="xs" />
              <Text size="xs" c="dimmed">{busy.label}</Text>
            </Group>
          ) : (
            <Text size="xs" c="dimmed" mb="xs">
              Channels are re-checked every 15 minutes, and the miner
              restarts when they change.
            </Text>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={(event) => void reorder(event)}
          >
            <SortableContext
              items={subs.map((s) => s.id)}
              strategy={verticalListSortingStrategy}
            >
              <Stack gap="xs">
                {subs.map((sub, index) => (
                  <SubscriptionRow
                    key={sub.id}
                    sub={sub}
                    index={index}
                    draggable={subs.length > 1}
                    restartPending={restartPending}
                    busy={busy !== null}
                    link={subscriptionLink(sub, data.campaigns)}
                    game={subscriptionGame(sub, data.campaigns)}
                    onOpen={() => setJumpedTo(sub.targetId)}
                    // Keyed to the campaign, not "panel": the card for
                    // this same subscription must go inert too, or it
                    // offers a second delete of what is already going.
                    onRemove={() => void mutate(
                      sub.targetId,
                      "Unsubscribing…",
                      () => api.post(`/api/subscriptions/${sub.id}/remove`),
                    )}
                    // A different pool size is a different set of
                    // channels, so this waits on a resolve like
                    // subscribing does.
                    onPoolSize={(poolSize) => void mutate(
                      sub.targetId,
                      "Finding channels to watch…",
                      () => api.post(
                        `/api/subscriptions/${sub.id}/pool-size`, { poolSize },
                      ),
                    )}
                  />
                ))}
              </Stack>
            </SortableContext>
          </DndContext>
        </Card>
      )}

      {shown.length === 0 ? (
        <Text c="dimmed" data-testid="campaigns-empty">
          {/* Three different claims, and the wrong one misreports the
              catalogue. A needle that matched nothing is about the
              search; an empty view is about the pills; only a genuinely
              empty catalogue is about the campaigns themselves. */}
          {filter.trim() !== ""
            ? "No campaigns match that filter."
            : !data.catalogueAvailable
              ? "No campaign list to show."
              : EMPTY[view]}
        </Text>
      ) : (
        <div className={classes.grid} data-testid="campaign-grid">
          {shown.map((campaign) => {
            const sub = subs.find(
              (x) => x.kind === "campaign" && x.targetId === campaign.id,
            );
            return (
              <CampaignCard
                key={campaign.id}
                campaign={campaign}
                subscribed={sub !== undefined}
                expand={
                  jumpedTo === campaign.id
                  || matchedByDropOnly(campaign, filter)
                }
                busy={busy?.key === campaign.id ? busy.label : undefined}
                onSubscribe={() => void mutate(
                  campaign.id,
                  "Finding channels to watch…",
                  () => api.post("/api/subscriptions", {
                    kind: "campaign", targetId: campaign.id,
                    label: campaign.name,
                  }),
                )}
                onUnsubscribe={() => {
                  if (sub !== undefined) {
                    void mutate(campaign.id, "Unsubscribing…", () => api.post(
                      `/api/subscriptions/${sub.id}/remove`,
                    ));
                  }
                }}
              />
            );
          })}
        </div>
      )}

    </Stack>
  );
}
