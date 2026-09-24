import {
  ActionIcon, Button, Drawer, Indicator, Stack, Text, Tooltip, UnstyledButton,
} from "@mantine/core";
import { IconBell } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { notifyApi, type InboxItem } from "../api/notify.js";
import { useStreamEvent } from "../api/useLiveState.js";
import { formatSpan } from "../lib/formatSpan.js";

const SEEN_KEY = "tw.notify.lastSeenId";
/** Matches the server's default page size. */
const PAGE = 50;

// Guarded: private mode throws on access, and a badge is never worth the page.
function readSeen(): number | null {
  try {
    const stored = localStorage.getItem(SEEN_KEY);
    return stored === null ? null : Number(stored);
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

  const unread = seen === null ? 0 : items.filter((i) => i.id > seen).length;

  const open = () => {
    setOpened(true);
    markSeen(items);
  };
  const close = () => {
    setOpened(false);
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
      <Drawer opened={opened} onClose={close} position="right" size="sm" title="Notifications">
        <Stack gap="xs">
          {items.length === 0 && (
            <Text size="sm" c="dimmed">
              Nothing yet. Miner problems, restarts, drops and updates show up here.
            </Text>
          )}
          {items.map((item) => (
            <UnstyledButton
              key={item.id}
              onClick={() => {
                close();
                onOpenLink(item.link);
              }}
              p="xs"
              style={{ borderRadius: 8, border: "1px solid var(--tw-border)" }}
            >
              <Text fw={600} size="sm">{item.title}</Text>
              <Text size="sm" c="dimmed">{item.body}</Text>
              <Text size="xs" c="dimmed">{formatSpan(now - item.ts)} ago</Text>
            </UnstyledButton>
          ))}
          {more && <Button variant="subtle" onClick={() => void loadMore()}>Load more</Button>}
          <Button
            variant="light"
            onClick={() => {
              close();
              onOpenSettings();
            }}
          >
            Notification settings
          </Button>
        </Stack>
      </Drawer>
    </>
  );
}
