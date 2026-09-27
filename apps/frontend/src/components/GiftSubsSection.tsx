import { ActionIcon, Alert, Anchor, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconGift, IconRefresh } from "@tabler/icons-react";
import { useState } from "react";
import { api } from "../api/client.js";
import { giftEnds, giftFrom, giftTitle } from "../lib/giftSubs.js";
import { useLocalToggle } from "../lib/useLocalToggle.js";
import { SectionHeading } from "./SectionHeading.js";
import classes from "./GiftSubsSection.module.css";
import type { GiftSub } from "../api/useLiveState.js";

/**
 * Every active gift sub on the account, below the streamer grids.
 *
 * The cards already badge the gifts for channels on the dashboard; this
 * is the one place that also shows the rest -- channels off the roster,
 * and gifts with no channel at all (Turbo).
 *
 * The heading stays even with nothing to list, because its refresh
 * button is the only way to pick up a gift the miner never reports (see
 * the backend's GiftSubsCache). The new list arrives through the live
 * state frame; the response here is read only for its error.
 */
export function GiftSubsSection({ gifts, roster, onOpenStreamer }: {
  gifts: GiftSub[];
  /** Logins on the dashboard, whose rows open the streamer detail. */
  roster: string[];
  onOpenStreamer?: (login: string) => void;
}) {
  const [open, toggleOpen] = useLocalToggle("dashboard.gifts", true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onDashboard = new Set(roster);
  const now = Date.now();

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await api.post<{ error: string | null }>("/api/gift-subs/refresh");
      setError(res.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <SectionHeading
        testId="gifts-heading"
        collapsed={!open}
        onToggle={toggleOpen}
        action={(
          <Tooltip label="Refresh gift subs">
            <ActionIcon
              variant="subtle" color="gray" size="sm"
              aria-label="Refresh gift subs"
              onClick={() => void refresh()} loading={refreshing}
            >
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      >
        {`GIFT SUBS · ${gifts.length}`}
      </SectionHeading>

      {error !== null && (
        <Alert role="alert" color="orange" py={6}>
          Could not refresh gift subs: {error}
        </Alert>
      )}

      {open && (gifts.length === 0
        ? <Text size="xs" c="dimmed">No active gift subs.</Text>
        : (
          <div className={classes.list}>
            {gifts.map((g) => (
              <div key={g.id} className={classes.row} data-testid="gift-row">
                <IconGift className={classes.icon} stroke={2} aria-hidden />
                <div className={classes.main}>
                  <GiftName gift={g} onDashboard={onDashboard} onOpen={onOpenStreamer} />
                  <Text size="xs" c="dimmed" className={classes.sub}>
                    {giftTitle(g)} · from {giftFrom(g) ?? "an anonymous gifter"}
                  </Text>
                </div>
                <Text size="xs" c="dimmed" className={classes.ends}>{giftEnds(g, now)}</Text>
              </div>
            ))}
          </div>
        ))}
    </>
  );
}

/**
 * The row's name: the streamer detail for a channel on the dashboard,
 * Twitch for one that is not, plain text for a gift with no channel.
 */
function GiftName({ gift: g, onDashboard, onOpen }: {
  gift: GiftSub;
  onDashboard: Set<string>;
  onOpen?: (login: string) => void;
}) {
  if (g.target === null) {
    return <Text size="sm" fw={600} truncate>{g.product}</Text>;
  }
  const target = g.target;
  if (onOpen && onDashboard.has(target.login)) {
    return (
      <UnstyledButton className={classes.name} onClick={() => onOpen(target.login)}>
        <Text size="sm" fw={600} truncate>{target.displayName}</Text>
      </UnstyledButton>
    );
  }
  return (
    <Anchor
      href={`https://twitch.tv/${target.login}`}
      target="_blank"
      rel="noopener noreferrer"
      size="sm"
      fw={600}
      className={classes.name}
    >
      {target.displayName}
    </Anchor>
  );
}
