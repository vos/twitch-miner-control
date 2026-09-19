import {
  Alert, Group, MultiSelect, SegmentedControl, Stack, Text, TextInput,
} from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";
import { atLeast, type Threshold } from "../lib/appLogLevel.js";
import type { LivePage } from "../lib/appendPage.js";
import { useLiveLog } from "../lib/useLiveLog.js";
import { AppEventRow, fieldsOf, type AppEvent } from "./AppEventRow.js";
import { LogViewport } from "./LogViewport.js";

/** Matches the server's ring capacity, so the tab stays bounded. */
const MAX_EVENTS = 500;

/** Whether an event matches the free-text filter. */
function matches(event: AppEvent, needle: string): boolean {
  if (needle === "") return true;
  const haystack = [
    event.type,
    event.msg ?? "",
    event.component ?? "",
    ...fieldsOf(event).map(([k, v]) => `${k}=${v}`),
  ].join(" ").toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

/**
 * What this backend decided, and why.
 *
 * The companion to the miner log beside it: that one carries Twitch's
 * side of the story, this one carries ours -- the pool decisions, the
 * automatic restarts, the user's own actions. Rendered as structure
 * rather than text because that is what it is, which is what makes it
 * filterable by level and component.
 */
export function AppLogView() {
  const [filter, setFilter] = useState("");
  const [threshold, setThreshold] = useState<Threshold>("all");
  const [components, setComponents] = useState<string[]>([]);

  const toPage = useCallback((body: unknown): LivePage<AppEvent> => {
    const page = body as { events?: AppEvent[]; total?: number };
    return { items: page.events ?? [], total: page.total ?? 0 };
  }, []);

  const { page, error, body } = useLiveLog<AppEvent>({
    endpoint: "/api/app-log", event: "app-log", maxItems: MAX_EVENTS, toPage,
  });

  const events = page?.items ?? [];
  // Absent until the first load answers; only an explicit false means the
  // server told us logging is switched off.
  const enabled = (body as { enabled?: boolean } | null)?.enabled !== false;

  // Offered from what is actually present, so the control never lists a
  // component that would filter everything away.
  const available = useMemo(
    () => [...new Set(events.map((e) => e.component ?? "other"))].sort(),
    [events],
  );

  const shown = events.filter((e) =>
    atLeast(e.level, threshold)
    && (components.length === 0 || components.includes(e.component ?? "other"))
    && matches(e, filter));

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Group gap="xs" wrap="wrap">
          <TextInput
            w={240}
            size="xs"
            placeholder="Filter events"
            aria-label="Filter events"
            leftSection={<IconSearch size={14} stroke={1.7} />}
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
          />
          <SegmentedControl
            size="xs"
            aria-label="Minimum level"
            value={threshold}
            onChange={(v) => setThreshold(v as Threshold)}
            data={[
              { label: "All", value: "all" },
              { label: "Info+", value: "info" },
              { label: "Warn+", value: "warn" },
              { label: "Errors", value: "error" },
            ]}
          />
          <MultiSelect
            w={210}
            size="xs"
            placeholder={components.length === 0 ? "All components" : undefined}
            aria-label="Components"
            data={available}
            value={components}
            onChange={setComponents}
            clearable
          />
        </Group>
        <Text size="xs" c="dimmed" ff="monospace">
          {shown.length} / {events.length} events
        </Text>
      </Group>

      {error && (
        <Alert role="alert" color="red">
          Failed to load app events: {error}
        </Alert>
      )}

      {!enabled && (
        // A disabled log is a configuration, not a failure. Saying so
        // beats a blank panel that looks like something is broken.
        <Alert color="gray">
          App event logging is switched off. Set <code>APP_LOG_LEVEL</code> in
          your <code>.env</code> to something other than <code>silent</code> to
          record what the app decides.
        </Alert>
      )}

      <LogViewport pinKey={page}>
        {enabled && events.length === 0 && (
          <Text size="xs" c="dimmed">
            No app events yet. They appear as the app makes decisions -- a
            subscription resolving, a restart, a sign-in.
          </Text>
        )}
        {shown.map((event, i) => (
          <AppEventRow key={`${event.time}-${i}-${event.type}`} event={event} />
        ))}
      </LogViewport>
    </Stack>
  );
}
