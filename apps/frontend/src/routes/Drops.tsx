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
import { useEffect, useMemo, useState } from "react";
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

/** "3h ago", or "just now" below a minute -- a zero span reads as broken. */
function age(at: number): string {
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
  sub, index, draggable, restartPending, busy, onRemove, onPoolSize,
}: {
  sub: SubscriptionRow;
  index: number;
  draggable: boolean;
  restartPending: boolean;
  busy: boolean;
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
      wrap="nowrap"
      gap="xs"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // The lifted row rides above its neighbours as they slide under it.
        zIndex: isDragging ? 1 : undefined,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
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
          <Text size="sm" lineClamp={1}>{sub.label}</Text>
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
              : restartPending
                ? `after the restart: ${sub.channels.join(", ")}`
                : `watching ${sub.channels.join(", ")}`}
          </Text>
        </div>
      </Group>
      <Group gap={6} wrap="nowrap">
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
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("");
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

  async function refresh() {
    setRefreshing(true);
    try {
      setData(await api.post<CampaignsPayload>("/api/campaigns/refresh"));
      setError(null);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched =
      needle === "" || data === null
        ? data?.campaigns ?? []
        : data.campaigns.filter((c) =>
            // Name, game or drop: the game is how most campaigns are
            // actually found, and the drop is often the only name the
            // player knows -- they are hunting a particular skin, not
            // whatever the campaign offering it is called. A separate box
            // per field would not earn its width.
            matchesHeader(c, needle) || matchesDrop(c, needle));

    // Three tiers, then soonest deadline within each.
    //
    //   1. Live, with progress on them -- watch time already committed
    //      outranks anything else, even something expiring sooner.
    //      `collected` is not promoted: it is finished, and lifting it
    //      would push campaigns that still need something down the page.
    //   2. Everything else live.
    //   3. Ended, whatever progress sits on it, because that progress is
    //      frozen and can never be finished. Kept rather than hidden:
    //      the tracker still lists them and a drop already earned is
    //      worth seeing.
    //
    // Within a tier: soonest deadline first, so 40/60 minutes expiring
    // tonight outranks 10/60 with a week left. No end date sorts after
    // dated ones -- an unknown deadline is not an urgent one -- and ties
    // break by name so a refresh does not reshuffle the list.
    const now = Date.now();
    const tier = (c: ResolvedCampaign) => {
      if (c.endsAt !== null && c.endsAt <= now) return 2;
      return c.status === "partial" ? 0 : 1;
    };
    return [...matched].sort((a, b) => {
      const byTier = tier(a) - tier(b);
      if (byTier !== 0) return byTier;
      const byEnd = (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity);
      return byEnd !== 0 ? byEnd : a.name.localeCompare(b.name);
    });
  }, [data, filter]);

  if (error !== null && data === null) {
    return (
      <Alert color="red" icon={<IconAlertTriangle />} data-testid="campaigns-error">
        Could not load drop campaigns: {error}
      </Alert>
    );
  }

  if (data === null) return <Loader />;

  return (
    // Capped a little wider than Settings' 760, because each row carries
    // a name, a game, a count and a deadline; left to fill the window,
    // the badge on the right drifts a screen away from the name on the
    // left. The bottom padding clears the pinned restart banner, which
    // would otherwise half-cover the last campaign.
    <Stack gap="md" maw={900} pb={140}>
      {/* align flex-end, not the default centre: the filter input is
          taller than the button because of its label, so centring drops
          the button below the input's baseline. */}
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <TextInput
          label="Filter"
          placeholder="Campaign, game or drop"
          leftSection={<IconSearch size={16} />}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          style={{ flex: "1 1 240px" }}
        />
        <Button
          variant="default"
          leftSection={<IconRefresh size={16} />}
          onClick={() => void refresh()}
          loading={refreshing}
        >
          Refresh
        </Button>
      </Group>

      <Group gap="md" wrap="wrap">
        <Text size="xs" c="dimmed" data-testid="catalogue-age">
          Campaigns updated {age(data.catalogueFetchedAt)}
        </Text>
        <Text size="xs" c="dimmed" data-testid="progress-age">
          Progress updated {age(data.progressFetchedAt)}
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
          This list could not be refreshed, so it may be missing campaigns
          announced since {age(data.catalogueFetchedAt)}.
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
          {data.campaigns.length > 0
            ? "No campaigns match that filter."
            : data.catalogueAvailable
              ? "No drop campaigns are running."
              : "No campaign list to show."}
        </Text>
      ) : (
        <Stack gap="xs">
          {shown.map((campaign) => {
            const sub = subs.find(
              (x) => x.kind === "campaign" && x.targetId === campaign.id,
            );
            return (
              <CampaignCard
                key={campaign.id}
                campaign={campaign}
                subscribed={sub !== undefined}
                expand={matchedByDropOnly(campaign, filter)}
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
        </Stack>
      )}

    </Stack>
  );
}
