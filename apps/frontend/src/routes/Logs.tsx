import { Alert, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { LogLine } from "../components/LogLine.js";

export function Logs() {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the newest line. A user who has
  // scrolled up is reading something; new lines must not yank them away.
  const pinned = useRef(true);

  useEffect(() => {
    const load = () =>
      api.get<{ lines: string[] }>("/api/logs")
        .then((r) => {
          setLines(r.lines);
          // A later successful poll must clear an earlier transient
          // failure -- otherwise a one-off hiccup leaves a permanent
          // error banner even though logs are flowing again.
          setError(null);
        })
        .catch((cause) => {
          // Surface the failure instead of leaving a blank/frozen log
          // panel with no explanation: this panel is exactly where an
          // operator looks to diagnose a crash, so a silently broken
          // fetch would hide the diagnosis when it is needed most.
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (pinned.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [lines]);

  const shown = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  return (
    <Stack gap="sm" h="calc(100vh - 120px)">
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

      <div
        ref={viewport}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 14px",
          border: "1px solid var(--tw-border)",
          borderRadius: 8,
          background: "var(--tw-bg)",
        }}
      >
        {shown.map((line, i) => <LogLine key={`${i}-${line}`} text={line} />)}
      </div>
    </Stack>
  );
}
