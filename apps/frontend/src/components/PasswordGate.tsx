import { Box, Button, Card, Center, PasswordInput, Stack, Text } from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api/client.js";
import { BrandMark } from "./BrandMark.js";
import { SessionContext } from "./session.js";

export interface PasswordGateProps {
  children: ReactNode;
  /**
   * Set once something else discovers the session is gone -- the live
   * stream 401ing, say. The mount-time check cannot notice that on its
   * own, which left a dead cookie rendering a full dashboard whose every
   * request was quietly failing until the user happened to refresh.
   */
  sessionExpired?: boolean;
}

export function PasswordGate({ children, sessionExpired = false }: PasswordGateProps) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Bumped on each failure to restart the shake animation -- re-rendering
  // with the same key would leave a finished animation finished.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api.get("/api/status").then(() => setUnlocked(true)).catch(() => setUnlocked(false));
  }, []);

  /**
   * Drop every trace of the finished session before showing the form
   * again -- leaving the old password in state would repopulate the
   * field for whoever sits down next.
   */
  const lock = () => {
    setUnlocked(false);
    setPassword("");
    setError(null);
  };

  if (unlocked === null) return null;
  if (unlocked && !sessionExpired) {
    return (
      <SessionContext.Provider value={{ onLoggedOut: lock }}>
        {children}
      </SessionContext.Provider>
    );
  }

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
                // The only thing there is to do on this screen, so the
                // user should be able to just start typing.
                data-autofocus
                autoFocus
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
