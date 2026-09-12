import { Popover, Text, UnstyledButton } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { formatViewers } from "../lib/formatViewers.js";
import classes from "./StreamContext.module.css";

interface Props {
  game: string | null;
  /** Null when offline: no stream means no audience, not an audience of 0. */
  viewers: number | null;
  /** The stream title, shown only in the popover. */
  title: string | null;
}

/**
 * The category and viewer count, under the streamer's name.
 *
 * Placed in the title block rather than the badge strip because it is
 * identity of a kind -- "what this channel is doing right now" belongs
 * with the name the way Twitch itself places it, and it reads as a
 * subtitle rather than as another status chip.
 *
 * The stream title is deliberately NOT rendered inline. Titles run long,
 * carry emoji and change mid-stream, so on a 320px card the line
 * truncates to noise. It goes in a Popover instead -- a Popover rather
 * than a Tooltip for the same reason MinerStatusBadge uses one: a
 * tooltip opens on hover only, so on a touch device the detail would be
 * unreachable.
 */
export function StreamContext({ game, viewers, title }: Props) {
  const [opened, { open, close, toggle }] = useDisclosure(false);
  // Hover is bound only where hovering is real. A touch tap synthesises
  // mouseenter and mouseleave around its click, so binding these
  // unconditionally let the mouseleave close what the click had just
  // opened -- leaving the title unreachable on exactly the devices this
  // is a Popover rather than a Tooltip for.
  const hoverable = typeof window !== "undefined"
    && window.matchMedia?.("(hover: hover)").matches === true;
  const hover = hoverable ? { onMouseEnter: open, onMouseLeave: close } : {};
  if (game === null) return null;

  const audience = formatViewers(viewers);
  const line = (
    <>
      <span className={classes.game}>{game}</span>
      {audience !== null && (
        <>
          <span className={classes.dot} aria-hidden>·</span>
          <span className={classes.viewers}>{audience}</span>
        </>
      )}
    </>
  );

  // Nothing to disclose without a title, so the context stays plain text
  // rather than advertising a control that opens an empty panel.
  if (title === null) {
    return <div className={classes.context} data-testid="stream-context">{line}</div>;
  }

  return (
    <Popover opened={opened} onDismiss={close} position="bottom-start" withArrow shadow="md" width={260}>
      <Popover.Target>
        <UnstyledButton
          className={`${classes.context} ${classes.interactive}`}
          {...hover}
          onClick={toggle}
          aria-label="Stream title"
          aria-expanded={opened}
          data-testid="stream-context"
        >
          {line}
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown>
        <Text size="xs">{title}</Text>
      </Popover.Dropdown>
    </Popover>
  );
}
