import { Alert, Button, Card, Center, PasswordInput, Stack } from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../api/client.js";

export function PasswordGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

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
    }
  };

  return (
    <Center h="100vh">
      <Card withBorder w={360} padding="lg">
        <Stack>
          {error && <Alert role="alert" color="red">{error}</Alert>}
          <PasswordInput
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
          <Button onClick={() => void submit()}>Unlock</Button>
        </Stack>
      </Card>
    </Center>
  );
}
