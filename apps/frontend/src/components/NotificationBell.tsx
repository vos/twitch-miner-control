import {
  ActionIcon, Box, Button, CloseButton, Drawer, Group, Indicator, Stack, Text, Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { IconBell, IconSettings, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { notifyApi, type InboxItem } from "../api/notify.js";
import { useStreamEvent } from "../api/useLiveState.js";
import { formatSpan } from "../lib/formatSpan.js";
import classes from "./NotificationBell.module.css";

const SEEN_KEY = "tw.notify.lastSeenId";
/** Matches the server's default page size. */
const PAGE = 50;

// Guarded: private mode throws on access, and a badge is never worth the page.
function readSeen(): number | null {
  try {
    const stored = localStorage.getItem(SEEN_KEY);
    if (stored === null) return null;
    const parsed = Number(stored);
    // A corrupt or hand-edited value (e.g. "" or garbage) must not poison
    // the unread count forever -- treat it as a first visit instead.
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSeen(id: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(id));
  } catch {
    // The count just resets next visit.
  }
}

/**
 * The inbox: what happened while nobody was looking. Unread is kept per
 * browser, as "newer than the last id this browser has seen".
 */
export function NotificationBell({ onOpenLink, onOpenSettings }: {
  onOpenLink: (link: string) => void;
  onOpenSettings: () => void;
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [more, setMore] = useState(false);
  const [seen, setSeen] = useState<number | null>(readSeen);
  const [opened, setOpened] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const markSeen = (list: InboxItem[]) => {
    const top = list[0]?.id;
    if (top === undefined) return;
    writeSeen(top);
    setSeen(top);
  };

  useEffect(() => {
    notifyApi.inbox()
      .then(({ items: page = [] }) => {
        setItems(page);
        setMore(page.length === PAGE);
        // A browser's first visit starts clean rather than badging the
        // whole history.
        if (readSeen() === null) {
          writeSeen(page[0]?.id ?? 0);
          setSeen(page[0]?.id ?? 0);
        }
      })
      .catch(() => undefined);
  }, []);

  useStreamEvent<InboxItem>("notification", (row) => {
    setItems((prev) => [row, ...prev.filter((i) => i.id !== row.id)]);
  });

  useStreamEvent<{ id: number }>("notification-removed", ({ id }) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  });

  useStreamEvent("notifications-cleared", () => {
    setItems([]);
    setMore(false);
  });

  const unread = seen === null ? 0 : items.filter((i) => i.id > seen).length;

  const open = () => {
    setOpened(true);
    markSeen(items);
  };
  const close = () => {
    setOpened(false);
    setConfirmClear(false);
    setError(null);
    // Anything that arrived while it was open has been seen too.
    markSeen(items);
  };

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (last === undefined) return;
    const { items: page = [] } = await notifyApi.inbox(last.id);
    setItems((prev) => [...prev, ...page]);
    setMore(page.length === PAGE);
  };

  // Not optimistic: a row that failed to go would otherwise vanish here
  // and come back on the next visit.
  const remove = async (id: number) => {
    setError(null);
    try {
      await notifyApi.removeInbox(id);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const clearAll = async () => {
    setError(null);
    try {
      await notifyApi.clearInbox();
      setItems([]);
      setMore(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    setConfirmClear(false);
  };

  const now = Date.now();
  return (
    <>
      <Tooltip label="Notifications">
        <Indicator label={unread > 99 ? "99+" : unread} size={16} offset={4} disabled={unread === 0}>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
            onClick={open}
          >
            <IconBell size={20} stroke={1.7} />
          </ActionIcon>
        </Indicator>
      </Tooltip>
      {/* Composed rather than <Drawer title>, to seat the actions beside the
          close button. */}
      <Drawer.Root opened={opened} onClose={close} position="right" size="sm">
        <Drawer.Overlay />
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>Notifications</Drawer.Title>
            <Group gap={4} wrap="nowrap">
              {items.length > 0 && (
                <Tooltip label="Clear all">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label="Clear all"
                    onClick={() => setConfirmClear(true)}
                  >
                    <IconTrash size={18} stroke={1.7} />
                  </ActionIcon>
                </Tooltip>
              )}
              <Tooltip label="Notification settings">
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  aria-label="Notification settings"
                  onClick={() => {
                    close();
                    onOpenSettings();
                  }}
                >
                  <IconSettings size={18} stroke={1.7} />
                </ActionIcon>
              </Tooltip>
              <Drawer.CloseButton />
            </Group>
          </Drawer.Header>
          <Drawer.Body>
            <Stack gap="xs">
              {confirmClear && items.length > 0 && (
                <>
                  <Text size="sm" c="dimmed">
                    This deletes every notification, including ones not loaded yet.
                  </Text>
                  <Group gap="xs">
                    <Button size="xs" color="red" onClick={() => void clearAll()}>Delete all</Button>
                    <Button size="xs" variant="default" onClick={() => setConfirmClear(false)}>
                      Cancel
                    </Button>
                  </Group>
                </>
              )}
              {error !== null && <Text size="sm" c="red">{error}</Text>}
              {items.length === 0 && (
                <Text size="sm" c="dimmed">
                  Nothing yet. Miner problems, restarts, drops and updates show up here.
                </Text>
              )}
              {items.map((item) => (
                <Box key={item.id} className={classes.row}>
                  <UnstyledButton
                    onClick={() => {
                      close();
                      onOpenLink(item.link);
                    }}
                    p="xs"
                    className={classes.card}
                  >
                    <Text fw={600} size="sm">{item.title}</Text>
                    <Text size="sm" c="dimmed">{item.body}</Text>
                    <Text size="xs" c="dimmed">{formatSpan(now - item.ts)} ago</Text>
                  </UnstyledButton>
                  {/* A sibling of the card, not inside it: a button can't hold a button. */}
                  <CloseButton
                    size="sm"
                    className={classes.dismiss}
                    aria-label={`Dismiss ${item.title}`}
                    onClick={() => void remove(item.id)}
                  />
                </Box>
              ))}
              {more && <Button variant="subtle" onClick={() => void loadMore()}>Load more</Button>}
            </Stack>
          </Drawer.Body>
        </Drawer.Content>
      </Drawer.Root>
    </>
  );
}
