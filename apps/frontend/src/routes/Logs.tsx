import { Alert, Code, ScrollArea, Stack, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

export function Logs() {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

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
          // operator looks to diagnose a crash (see the design spec's
          // crash banner), so a silently broken fetch would hide the
          // diagnosis when it is needed most. Mirrors Streamers.tsx and
          // Dashboard.tsx's error-surfacing convention.
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <Stack>
      <Title order={2}>Logs</Title>
      {error && (
        <Alert role="alert" color="red">
          Failed to load logs: {error}
        </Alert>
      )}
      <ScrollArea h={600}>
        <Code block>{lines.join("\n")}</Code>
      </ScrollArea>
    </Stack>
  );
}
