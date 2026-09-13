import { Alert, Group, Stack, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { useStreamEvent } from "../api/useLiveState.js";
import { LogLine } from "../components/LogLine.js";

/** Matches the server's LogBuffer capacity, so a long-lived tab stays bounded. */
const MAX_LINES = 2000;

/** Delay before trying a failed load again. */
const RETRY_MS = 5000;

/**
 * Lines of miner output, with `total` counting every line the server has
 * ever logged -- the same count a log frame carries, which is how a frame's
 * lines are placed against what is already on screen.
 */
export interface LogPage {
  lines: string[];
  total: number;
}

/**
 * Adds a pushed frame's new lines to `current`. Lines already there are
 * skipped; null means lines were missed between the two, so only a reload
 * can close the gap.
 */
export function appendLog(current: LogPage, frame: LogPage): LogPage | null {
  const fresh = frame.total - current.total;
  if (fresh <= 0) return current;
  if (fresh > frame.lines.length) return null;
  return {
    lines: [...current.lines, ...frame.lines.slice(frame.lines.length - fresh)].slice(-MAX_LINES),
    total: frame.total,
  };
}

export function Logs() {
  const [log, setLog] = useState<LogPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to load the whole log again.
  const [reloads, setReloads] = useState(0);
  const [filter, setFilter] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  // Whether the view is pinned to the newest line. A user who has
  // scrolled up is reading something; new lines must not yank them away.
  const pinned = useRef(true);
  // What frames append to: the rendered log, kept in a ref so two frames in
  // one tick each build on the one before. Null while a load is in flight.
  const base = useRef<LogPage | null>(null);
  // Frames that arrived while a load was in flight, applied on top of it.
  const early = useRef<LogPage[]>([]);

  const show = (page: LogPage) => {
    base.current = page;
    setLog(page);
  };

  useStreamEvent<LogPage>("log", (frame) => {
    if (base.current === null) {
      early.current.push(frame);
      return;
    }
    const next = appendLog(base.current, frame);
    if (next === null) setReloads((n) => n + 1);
    else if (next !== base.current) show(next);
  });

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    base.current = null;
    early.current = [];

    const load = () =>
      api.get<LogPage>("/api/logs")
        .then((page) => {
          if (!alive) return;
          // The load already holds everything logged before it answered, so
          // these frames can only add to it -- a gap is not possible here.
          const merged = early.current.reduce((acc, frame) => appendLog(acc, frame) ?? acc, page);
          early.current = [];
          show(merged);
          // A success after a failed attempt must clear its banner --
          // otherwise a one-off hiccup leaves a permanent error even though
          // logs are flowing again.
          setError(null);
        })
        .catch((cause) => {
          if (!alive) return;
          // Surface the failure instead of leaving a blank/frozen log
          // panel with no explanation: this panel is exactly where an
          // operator looks to diagnose a crash, so a silently broken
          // fetch would hide the diagnosis when it is needed most.
          setError(cause instanceof Error ? cause.message : String(cause));
          retry = setTimeout(load, RETRY_MS);
        });
    void load();
    return () => {
      alive = false;
      if (retry !== null) clearTimeout(retry);
    };
  }, [reloads]);

  const lines = log?.lines ?? [];

  useEffect(() => {
    if (pinned.current && viewport.current) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  }, [log]);

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
