import { Alert, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useLiveLog } from "../lib/useLiveLog.js";
import type { LivePage } from "../lib/appendPage.js";
import { LogLine } from "./LogLine.js";
import { LogViewport } from "./LogViewport.js";

/** Matches the server's LogBuffer capacity, so a long-lived tab stays bounded. */
const MAX_LINES = 2000;

/** The miner's own output, streamed live. */
export function MinerLogView() {
  const [filter, setFilter] = useState("");
  const toPage = useCallback(
    (body: unknown): LivePage<string> => {
      const page = body as { lines?: string[]; total?: number };
      return { items: page.lines ?? [], total: page.total ?? 0 };
    },
    [],
  );
  const { page, error } = useLiveLog<string>({
    endpoint: "/api/logs", event: "log", maxItems: MAX_LINES, toPage,
  });

  const lines = page?.items ?? [];
  const shown = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Group justify="space-between">
        <TextInput
          w={280}
          size="xs"
          placeholder="Filter lines"
          aria-label="Filter lines"
          leftSection={<IconSearch size={14} stroke={1.7} />}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
        <Text size="xs" c="dimmed" ff="monospace">
          {shown.length} / {lines.length} lines
        </Text>
      </Group>

      {error && (
        <Alert role="alert" color="red">
          Failed to load logs: {error}
        </Alert>
      )}

      <LogViewport pinKey={page}>
        {shown.map((line, i) => <LogLine key={`${i}-${line}`} text={line} />)}
      </LogViewport>
    </Stack>
  );
}
