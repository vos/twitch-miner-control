import { Button, Group, Text } from "@mantine/core";
import { useState } from "react";

type State = { kind: "idle" | "sending" | "sent" } | { kind: "failed"; error: string };

/** Sends a test notification and says how it went. `onTest` resolves with an error, or null. */
export function TestButton({ onTest, size = "sm" }: {
  onTest: () => Promise<string | null>;
  size?: "xs" | "sm";
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  return (
    <Group gap="xs">
      <Button
        size={size}
        variant="default"
        loading={state.kind === "sending"}
        onClick={async () => {
          setState({ kind: "sending" });
          const error = await onTest();
          setState(error === null ? { kind: "sent" } : { kind: "failed", error });
        }}
      >
        Send test
      </Button>
      {state.kind === "sent" && <Text size="sm" c="dimmed">Sent</Text>}
      {state.kind === "failed" && <Text size="sm" c="red">{state.error}</Text>}
    </Group>
  );
}
