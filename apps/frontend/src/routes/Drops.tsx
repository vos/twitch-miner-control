import {
  Alert, Anchor, Button, Group, Loader, Stack, Text, TextInput,
} from "@mantine/core";
import {
  IconAlertTriangle, IconExternalLink, IconRefresh, IconSearch,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { CampaignCard, type ResolvedCampaign } from "../components/CampaignCard.js";
import { formatSpan } from "../lib/formatSpan.js";

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
            // Name or game: the game is how most campaigns are actually
            // found, and a second box for it would not earn its width.
            c.name.toLowerCase().includes(needle)
            || (c.game?.displayName.toLowerCase().includes(needle) ?? false));

    // Soonest deadline first: the only ordering that answers the
    // question the page is opened with -- what runs out next. The source
    // returns its own order, which the user cannot see or reason about.
    //
    // Ended campaigns go to the bottom first, whatever their deadline.
    // Sorting purely by deadline promotes them to the very top, giving
    // the most prominent row on the page to the one thing that can no
    // longer be acted on. They are kept rather than hidden because the
    // tracker still lists them and a drop already earned is still worth
    // seeing.
    //
    // Then: no end date after dated ones -- an unknown deadline is not
    // an urgent one -- and ties broken by name, so a refresh does not
    // reshuffle the list.
    const now = Date.now();
    const ended = (c: ResolvedCampaign) =>
      c.endsAt !== null && c.endsAt <= now;
    return [...matched].sort((a, b) => {
      if (ended(a) !== ended(b)) return ended(a) ? 1 : -1;
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
    // Capped like Settings (maw 760 there), a little wider because each
    // row carries a name, a game, a count and a deadline. Left to fill
    // the window, the badge on the right drifts a screen away from the
    // name on the left and the row stops reading as one thing.
    <Stack gap="md" maw={900} pb={80}>
      {/* align flex-end, not the default centre: the filter input is
          taller than the button because of its label, so centring drops
          the button below the input's baseline. */}
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <TextInput
          label="Filter"
          placeholder="Campaign or game"
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
          {shown.map((campaign) => (
            <CampaignCard key={campaign.id} campaign={campaign} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
