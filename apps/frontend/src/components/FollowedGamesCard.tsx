import { Anchor, Button, Card, Group, Stack, Text } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { type FollowedGame, type SkippedCampaign, runningCampaigns } from "../lib/followedGames.js";
import { CampaignBoxArt } from "./CampaignBoxArt.js";
import type { ResolvedCampaign } from "./CampaignCard.js";
import { PoolSizeInput } from "./PoolSizeInput.js";

/**
 * The games whose drop campaigns are subscribed to as they appear.
 *
 * Always rendered, even with nothing followed: it is the only way to
 * follow a first game. Rows are not ranked -- a followed game mines
 * nothing itself, its campaigns join the subscription list below -- so
 * they are listed by name.
 */
export function FollowedGamesCard({
  games, campaigns, skipped, busy, notice, onAdd, onRemove, onPoolSize,
}: {
  games: FollowedGame[];
  campaigns: ResolvedCampaign[];
  /** Skipped campaigns still worth unskipping, to count per game. */
  skipped: SkippedCampaign[];
  busy: boolean;
  /** What the last follow did, or null. */
  notice: string | null;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onPoolSize: (id: string, size: number) => void;
}) {
  return (
    <Card withBorder padding="sm" data-testid="followed-games">
      <Group justify="space-between" align="center" mb={4}>
        <Text fw={600} size="sm">Followed games</Text>
        <Button
          size="compact-xs"
          leftSection={<IconPlus size={14} />}
          disabled={busy}
          onClick={onAdd}
        >
          Follow games
        </Button>
      </Group>
      {notice !== null && (
        <Text size="xs" c="teal" mb="xs" data-testid="follow-notice">{notice}</Text>
      )}
      {games.length === 0 ? (
        <Text size="xs" c="dimmed">
          Follow a game to subscribe to its drop campaigns automatically as they appear.
        </Text>
      ) : (
        <Stack gap="xs">
          {[...games]
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
            .map((game) => {
              const count = runningCampaigns(game.id, campaigns);
              const skips = skipped.filter((s) => s.game.id === game.id).length;
              return (
                <Group
                  key={game.id}
                  justify="space-between"
                  wrap="wrap"
                  gap="xs"
                  data-testid="followed-game"
                >
                  <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: "1 1 220px" }}>
                    <CampaignBoxArt url={game.boxArtUrl} displayName={game.name} width={30} />
                    <div style={{ minWidth: 0 }}>
                      {game.slug === "" ? (
                        <Text size="sm" lineClamp={1}>{game.name}</Text>
                      ) : (
                        <Anchor
                          size="sm"
                          lineClamp={1}
                          href={`https://twitch.tv/directory/category/${game.slug}`}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {game.name}
                        </Anchor>
                      )}
                      <Text size="xs" c="dimmed">
                        {count === 0
                          ? "No campaigns right now"
                          : count === 1 ? "1 campaign running" : `${count} campaigns running`}
                        {skips > 0 && ` · ${skips} skipped`}
                      </Text>
                    </div>
                  </Group>
                  <Group gap={6} wrap="nowrap">
                    <PoolSizeInput
                      value={game.poolSize}
                      label={`Channels for ${game.name}`}
                      hint={
                        "How many channels to keep for each campaign this game "
                        + "subscribes to. Applies to campaigns added from now on."
                      }
                      disabled={busy}
                      onCommit={(size) => onPoolSize(game.id, size)}
                    />
                    <Text size="xs" c="dimmed">channels</Text>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="gray"
                      aria-label={`Unfollow ${game.name}`}
                      loading={busy}
                      onClick={() => onRemove(game.id)}
                    >
                      Remove
                    </Button>
                  </Group>
                </Group>
              );
            })}
        </Stack>
      )}
    </Card>
  );
}
