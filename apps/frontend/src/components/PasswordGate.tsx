import { Box, Button, Card, Center, PasswordInput, Stack, Text } from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api/client.js";
import { BrandMark } from "./BrandMark.js";

export function PasswordGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Bumped on each failure to restart the shake animation -- re-rendering
  // with the same key would leave a finished animation finished.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api.get("/api/status").then(() => setUnlocked(true)).catch(() => setUnlocked(false));
  }, []);

  if (unlocked === null) return null;
  if (unlocked) return <>{children}</>;

  const submit = async () => {
    setError(null);
    try {
      await api.post("/api/session", { password });
      setUnlocked(true);
    } catch {
      setError("Wrong password");
      setAttempt((n) => n + 1);
    }
  };

  return (
    <Center
      h="100vh"
      style={{
        background:
          "radial-gradient(circle at 50% 35%, rgba(145,71,255,0.18), transparent 55%),"
          + " var(--tw-bg)",
      }}
    >
      <Stack align="center" gap="xl" w={400} px="md">
        <Stack align="center" gap="xs">
          <BrandMark size={96} />
          <Text fw={700} size="xl" style={{ letterSpacing: "0.1em" }}>
            MINER CONTROL
          </Text>
          <Text size="sm" c="dimmed">Twitch Channel Points</Text>
        </Stack>
        <Box
          key={attempt}
          w="100%"
          style={error ? { animation: "tw-shake 350ms ease" } : undefined}
        >
          <Card withBorder padding="lg" w="100%">
            <Stack>
              <PasswordInput
                label="Password"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              />
              {/* An explicit alert element rather than PasswordInput's
                  `error` prop: the message must be announced, and this
                  keeps one obvious node carrying role="alert". */}
              {error && (
                <Text role="alert" size="sm" c="red">{error}</Text>
              )}
              <Button fullWidth onClick={() => void submit()}>Unlock</Button>
            </Stack>
          </Card>
        </Box>
      </Stack>
    </Center>
  );
}
