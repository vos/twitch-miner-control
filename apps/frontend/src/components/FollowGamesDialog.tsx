import {
  Alert, Badge, Button, Checkbox, Group, Loader, Modal, Pill, ScrollArea, Stack, Text, TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { type FollowedGame, type TwitchGame, runningCampaigns } from "../lib/followedGames.js";
import { CampaignBoxArt } from "./CampaignBoxArt.js";
import type { ResolvedCampaign } from "./CampaignCard.js";

type Search =
  | { state: "short" }
  | { state: "loading" }
  | { state: "error" }
  | { state: "done"; games: TwitchGame[] };

const confirmLabel = (n: number) =>
  n === 0 ? "Follow games" : n === 1 ? "Follow 1 game" : `Follow ${n} games`;

/**
 * Searches Twitch's categories and follows the ticked ones.
 *
 * Picks are kept across searches, so several games can be gathered from
 * different queries and followed at once. "No matches" and "search
 * failed" are separate states: presenting a failure as no matches would
 * tell the user a game does not exist.
 */
export function FollowGamesDialog({ opened, onClose, followed, campaigns, onConfirm }: {
  opened: boolean;
  onClose: () => void;
  followed: FollowedGame[];
  campaigns: ResolvedCampaign[];
  /** Rejects to keep the dialog open with the reason shown. */
  onConfirm: (games: TwitchGame[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [debounced] = useDebouncedValue(query.trim(), 300);
  const [search, setSearch] = useState<Search>({ state: "short" });
  const [picked, setPicked] = useState<TwitchGame[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const following = new Set(followed.map((g) => g.id));

  useEffect(() => {
    if (debounced.length < 2) {
      setSearch({ state: "short" });
      return;
    }
    // Dropped when superseded, so a slow older answer cannot replace a
    // newer one.
    let live = true;
    setSearch({ state: "loading" });
    api.get<{ games: TwitchGame[] }>(`/api/games/search?q=${encodeURIComponent(debounced)}`)
      .then((res) => { if (live) setSearch({ state: "done", games: res.games }); })
      .catch(() => { if (live) setSearch({ state: "error" }); });
    return () => { live = false; };
  }, [debounced]);

  function toggle(game: TwitchGame) {
    setPicked((list) => (list.some((g) => g.id === game.id)
      ? list.filter((g) => g.id !== game.id)
      : [...list, game]));
  }

  function close() {
    setQuery("");
    setPicked([]);
    setFailure(null);
    onClose();
  }

  async function confirm() {
    setSaving(true);
    setFailure(null);
    try {
      await onConfirm(picked);
      close();
    } catch (cause: unknown) {
      setFailure(cause instanceof Error ? cause.message : "could not follow those games");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal opened={opened} onClose={close} title="Follow games" size="lg">
      <Stack gap="sm">
        <TextInput
          data-autofocus
          aria-label="Search Twitch games"
          placeholder="Game name or Twitch ID"
          leftSection={<IconSearch size={16} />}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        {picked.length > 0 && (
          <Pill.Group data-testid="follow-picked">
            {picked.map((g) => (
              <Pill key={g.id} withRemoveButton onRemove={() => toggle(g)}>{g.name}</Pill>
            ))}
          </Pill.Group>
        )}
        <ScrollArea.Autosize mah={360}>
          {search.state === "short" && (
            <Text size="sm" c="dimmed">Type a game name or Twitch ID</Text>
          )}
          {search.state === "loading" && (
            <Group gap="xs">
              <Loader size="xs" />
              <Text size="sm" c="dimmed">Searching Twitch…</Text>
            </Group>
          )}
          {search.state === "error" && (
            <Alert color="yellow">Twitch search is unavailable — try again shortly</Alert>
          )}
          {search.state === "done" && search.games.length === 0 && (
            <Text size="sm" c="dimmed">No matching games</Text>
          )}
          {search.state === "done" && search.games.map((game) => {
            const already = following.has(game.id);
            const count = runningCampaigns(game.id, campaigns);
            return (
              <Group key={game.id} gap="sm" wrap="nowrap" py={4} data-testid="follow-result">
                <Checkbox
                  aria-label={`Follow ${game.name}`}
                  checked={already || picked.some((g) => g.id === game.id)}
                  disabled={already}
                  onChange={() => toggle(game)}
                />
                <CampaignBoxArt url={game.boxArtUrl} displayName={game.name} width={36} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Text size="sm" lineClamp={1}>{game.name}</Text>
                  <Text size="xs" c="dimmed" ff="monospace">{game.id}</Text>
                </div>
                {count > 0 && (
                  <Badge size="xs" variant="light" color="teal">
                    {count === 1 ? "1 campaign" : `${count} campaigns`}
                  </Badge>
                )}
                {already && <Badge size="xs" variant="light" color="gray">Following</Badge>}
              </Group>
            );
          })}
        </ScrollArea.Autosize>
        {failure !== null && <Alert color="red">{failure}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>Cancel</Button>
          <Button
            disabled={picked.length === 0}
            loading={saving}
            onClick={() => void confirm()}
          >
            {confirmLabel(picked.length)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
