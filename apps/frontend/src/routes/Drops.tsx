import {
  Alert, Button, Group, Loader, Stack, Text, TextInput,
} from "@mantine/core";
import { IconAlertTriangle, IconRefresh, IconSearch } from "@tabler/icons-react";
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
  /** Epoch ms the progress was fetched. */
  progressFetchedAt: number;
  /** False when the inventory could not be read at all. */
  progressAvailable: boolean;
}

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
    if (needle === "" || data === null) return data?.campaigns ?? [];
    // Name or game: the game is how most campaigns are actually found,
    // and a second box for it would not earn its width.
    return data.campaigns.filter((c) =>
      c.name.toLowerCase().includes(needle)
      || (c.game?.displayName.toLowerCase().includes(needle) ?? false));
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
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
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

      <Group gap="md">
        <Text size="xs" c="dimmed" data-testid="catalogue-age">
          Campaigns updated {age(data.catalogueFetchedAt)}
        </Text>
        <Text size="xs" c="dimmed" data-testid="progress-age">
          Progress updated {age(data.progressFetchedAt)}
        </Text>
      </Group>

      {data.catalogueStale && (
        <Alert color="yellow" data-testid="catalogue-stale">
          This list could not be refreshed, so it may be missing campaigns
          announced since {age(data.catalogueFetchedAt)}.
        </Alert>
      )}

      {!data.progressAvailable && (
        <Alert color="yellow" data-testid="progress-unavailable">
          Your drop progress is unavailable right now, so these campaigns
          show what they award but not how far along you are.
        </Alert>
      )}

      {shown.length === 0 ? (
        <Text c="dimmed" data-testid="campaigns-empty">
          {data.campaigns.length === 0
            ? "No drop campaigns are running."
            : "No campaigns match that filter."}
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
