import { Badge, Button, Group, Text } from "@mantine/core";
import type { SkippedCampaign } from "../lib/followedGames.js";

/**
 * A campaign a followed game skipped, kept in view so it can be undone.
 *
 * Not ranked and not draggable: it owns no channels and holds no place in
 * the queue. Unskipping hands it back to the game, which subscribes to it
 * again at the end of the list.
 */
export function SkippedCampaignRow({ skipped, withGrip, busy, onUnskip }: {
  skipped: SkippedCampaign;
  /** Whether the rows above show a drag grip, to line the name up with theirs. */
  withGrip: boolean;
  busy: boolean;
  onUnskip: () => void;
}) {
  const { campaign, game } = skipped;
  return (
    <Group
      justify="space-between"
      wrap="wrap"
      gap="xs"
      style={{ opacity: 0.6 }}
      data-testid="skipped-row"
    >
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: "1 1 260px" }}>
        {/* Where the grip and the rank sit on the rows above, so the names
            line up. */}
        {withGrip && <div style={{ width: 28, flexShrink: 0 }} />}
        <div style={{ width: 16, flexShrink: 0 }} />
        <Group gap={6} wrap="nowrap" align="baseline" style={{ minWidth: 0 }}>
          <Text size="sm" lineClamp={1}>{campaign.name}</Text>
          <Badge
            size="xs"
            variant="light"
            color="gray"
            style={{ flexShrink: 0 }}
            data-testid="skipped-badge"
          >
            skipped
          </Badge>
          <Text size="xs" c="dimmed" lineClamp={1} style={{ flexShrink: 1000, minWidth: 0 }}>
            {game.name}
          </Text>
        </Group>
      </Group>
      <Button
        size="compact-xs"
        variant="subtle"
        color="gray"
        loading={busy}
        onClick={onUnskip}
      >
        Unskip
      </Button>
    </Group>
  );
}
