import { ActionIcon, Badge, Card, Switch, Text, Tooltip } from "@mantine/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconGripVertical, IconSettings, IconX } from "@tabler/icons-react";
import { OwnedBadge } from "./OwnedBadge.js";
import { StatusPill } from "./StatusPill.js";
import { StreamerAvatar } from "./StreamerAvatar.js";
import classes from "./StreamerRow.module.css";

/** What the live snapshot knows about this channel; null when unreachable. */
export interface RowStatus {
  avatarUrl: string | null;
  isOnline: boolean | null;
  liveSince: number | null;
  lastLive: number | null;
  /**
   * Whether the miner is actually watching this channel, as observed by
   * the backend from watch-point gains. Absent on a snapshot from a
   * backend that predates the field, which reads as "not watching" --
   * no badge, rather than a guess.
   */
  watching?: boolean;
}

interface Props {
  username: string;
  enabled: boolean;
  status: RowStatus | null;
  /** 0-based position, shown as the priority number and drives the tint. */
  index: number;
  /**
   * Whether the miner is observed to be watching this channel right now.
   *
   * Not a function of position: the miner fills its two watch slots from
   * the channels that are live with points enabled, and a pending watch
   * streak or drop can promote one over a higher-priority channel. This
   * reports what is happening, so it is legitimately empty when nothing
   * is being mined -- the miner stopped, everyone offline, or a slot not
   * yet confirmed by a first watch gain.
   */
  watching: boolean;
  /**
   * The drop campaign whose subscription put this channel here, or null
   * for a channel the user added by hand.
   *
   * A label rather than a boolean: "where did this come from" is the
   * question an unfamiliar channel in the list actually raises, and the
   * campaign name answers it outright.
   */
  ownedByLabel?: string | null;
  /**
   * The game that campaign is for, or null when it is not known.
   *
   * What the badge actually shows: a viewer recognises "Delta Force"
   * and cannot place "DF Streamer Ladder FINNAL", which is the same
   * campaign. The label stays the fallback and the `title`.
   */
  ownedByGame?: string | null;
  onToggle: () => void;
  onRemove: () => void;
  onOpenSettings: () => void;
}

/**
 * One draggable row of the streamer priority list.
 *
 * The drag listeners sit on the grip, not the card: the row also holds a
 * channel link (natively draggable) and a switch, and a whole-card handle
 * makes those fight the reorder.
 *
 * Laid out as a grid rather than nested rows -- see StreamerRow.module.css
 * for why the controls have to be the side that keeps its width.
 */
export function StreamerRow(
  {
    username, enabled, status, index, watching, ownedByLabel = null,
    ownedByGame = null, onToggle, onRemove, onOpenSettings,
  }: Props,
) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform,
    transition, isDragging,
  } = useSortable({ id: username });
  const owned = ownedByLabel !== null && ownedByLabel !== "";

  return (
    <Card
      withBorder
      ref={setNodeRef}
      data-testid="streamer-row"
      padding="sm"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // The lifted row rides above its neighbours as they slide under it.
        zIndex: isDragging ? 1 : undefined,
        opacity: isDragging ? 0.6 : undefined,
        // Tied to the badge, so the tint marks what is being mined rather
        // than the first two positions. The number in the row already says
        // where a streamer sits in the order; tinting by position as well
        // restated it in a way that read as "these two are active".
        ...(watching
          ? { background: "rgba(145,71,255,0.08)", borderColor: "var(--tw-purple)" }
          : {}),
      }}
    >
      <div className={classes.row}>
        <div className={classes.identity}>
          {/* No grip on an owned row: the engine writes these in its own
              subscription rank order on every pass, so a position dragged
              here would last until the next one. Reordering them is the
              Drops screen's job, where the rank actually lives. The empty
              slot keeps the rest of the row aligned with its neighbours. */}
          {owned ? (
            <div className={classes.grip} aria-hidden />
          ) : (
            <ActionIcon
              variant="subtle"
              color="gray"
              className={classes.grip}
              ref={setActivatorNodeRef}
              aria-label={`Reorder ${username}`}
              style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
              {...attributes}
              {...listeners}
            >
              <IconGripVertical size={16} />
            </ActionIcon>
          )}
          <Text size="sm" c="dimmed" ff="monospace" w={20} className={classes.index}>
            {index + 1}
          </Text>
          <div className={classes.avatar}>
            <StreamerAvatar
              login={username}
              avatarUrl={status?.avatarUrl ?? null}
              size={28}
              live={status?.isOnline === true}
            />
          </div>
          {/* The full name in `title`: this is the element that truncates,
              so the whole of it has to stay available somewhere. */}
          <Text
            component="a"
            href={`https://twitch.tv/${username}`}
            target="_blank"
            rel="noopener noreferrer"
            fw={500}
            truncate
            className={classes.name}
            title={username}
          >
            {username}
          </Text>
          {watching && (
            <Badge
              size="xs" variant="light" color="twitch" data-testid="watching-tag"
              className={classes.badge}
              title="The miner is currently watching this channel."
            >
              watching
            </Badge>
          )}
          {owned && (
            <OwnedBadge
              label={ownedByLabel}
              game={ownedByGame}
              testId="owned-tag"
              size="xs"
            />
          )}
          {/* Live state is what the ordering decision is actually made on,
              so it sits on the row being dragged. Absent when the miner is
              unreachable -- see StatusPill. */}
          <div className={classes.status}>
            <StatusPill
              isOnline={status?.isOnline ?? null}
              liveSince={status?.liveSince ?? null}
              lastLive={status?.lastLive ?? null}
            />
          </div>
        </div>
        <div className={classes.controls}>
          <Switch
            checked={enabled}
            onChange={onToggle}
            aria-label={`Enable ${username}`}
          />
          {/* Neither control is offered on an owned row. Removing it by
              hand is undone by the next resolve, which puts the channel
              straight back -- the subscription, not the list, is what
              decides this channel is here. Per-channel settings would
              survive a pass (reconcile reuses the existing entry) but not
              the channel leaving the pool, so they are effort staked on a
              row that can disappear on any pass. Both are reached by
              unsubscribing on the Drops screen, which the badge says.

              The switch stays: `enabled` is the user's say over whether
              the miner watches a channel at all, and reconcile carries it
              across passes. */}
          {!owned && (
            <>
              <Tooltip label={`Settings for ${username}`}>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  onClick={onOpenSettings}
                  aria-label={`Settings for ${username}`}
                >
                  <IconSettings size={16} />
                </ActionIcon>
              </Tooltip>
              {/* Removal is staged like every other edit on this screen -- it
                  drops the row from the draft and the pending bar counts it, so
                  a stray click costs an Apply, not a config. */}
              <Tooltip label={`Remove ${username}`}>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={onRemove}
                  aria-label={`Remove ${username}`}
                >
                  <IconX size={16} />
                </ActionIcon>
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
