import { Anchor, Badge, Group, Popover, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconGift } from "@tabler/icons-react";
import { giftEnds, giftFrom, giftTitle } from "../lib/giftSubs.js";
import classes from "./GiftBadge.module.css";
import type { GiftSub } from "../api/useLiveState.js";

/**
 * A gift sub the account holds for this channel, with its detail behind
 * a tap -- a Popover for the reason DropBadge uses one: a tooltip never
 * opens on a phone.
 *
 * Icon only: the strip it sits in is already full of words at the
 * dashboard's 320px minimum, and the gift glyph says enough on its own.
 * Who gave it and when it ends live in the panel.
 */
export function GiftBadge({ gift }: { gift: GiftSub }) {
  const [opened, { open, close, toggle }] = useDisclosure(false);
  // Hover only where hovering is real; see DropBadge.
  const hoverable = typeof window !== "undefined"
    && window.matchMedia?.("(hover: hover)").matches === true;
  const hover = hoverable ? { onMouseEnter: open, onMouseLeave: close } : {};
  const from = giftFrom(gift);

  return (
    <Popover
      opened={opened}
      onDismiss={close}
      position="bottom-start"
      withArrow
      shadow="md"
      width={240}
    >
      <Popover.Target>
        <Badge
          component="button"
          type="button"
          color="pink"
          variant="light"
          size="sm"
          data-testid="gift-sub"
          className={classes.badge}
          {...hover}
          onClick={toggle}
          aria-expanded={opened}
          aria-label={`${giftTitle(gift)} from ${from ?? "an anonymous gifter"}`}
        >
          <IconGift className={classes.icon} stroke={2} aria-hidden />
        </Badge>
      </Popover.Target>
      <Popover.Dropdown data-testid="gift-detail">
        <Group gap={6} wrap="nowrap">
          <IconGift className={classes.detailIcon} stroke={2} aria-hidden />
          <Text size="xs" fw={600}>{giftTitle(gift)}</Text>
        </Group>
        <Text size="xs" mt={6}>
          from{" "}
          {gift.gifter === null
            ? "an anonymous gifter"
            : (
              <Anchor
                href={`https://twitch.tv/${gift.gifter.login}`}
                target="_blank"
                rel="noopener noreferrer"
                size="xs"
                fw={600}
              >
                {from}
              </Anchor>
            )}
        </Text>
        <Text size="xs" c="dimmed" mt={4}>{giftEnds(gift, Date.now())}</Text>
      </Popover.Dropdown>
    </Popover>
  );
}
