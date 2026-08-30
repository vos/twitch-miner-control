import { Alert, Anchor, Button, Card, Code, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

type Progress =
  | { stage: "code"; userCode: string; verificationUri: string; expiresAt: number }
  | { stage: "pending" }
  | { stage: "ok"; username: string }
  | { stage: "error"; error: string }
  | null;

export function TwitchLogin() {
  const [progress, setProgress] = useState<Progress>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.get<{ login: Progress }>("/api/status")
      .then((s) => setProgress(s.login))
      .finally(() => setLoaded(true));
    const source = new EventSource("/api/stream");
    source.addEventListener("login", (event) => {
      try {
        setProgress(JSON.parse((event as MessageEvent).data) as Progress);
      } catch {
        // ignore malformed frames
      }
    });
    return () => source.close();
  }, []);

  if (!loaded) return null;

  return (
    <Stack>
      <Title order={2}>Twitch account</Title>
      {progress?.stage === "error" && (
        <Alert role="alert" color="red">{progress.error}</Alert>
      )}
      {progress?.stage === "ok" && (
        <Text>Signed in as {progress.username}</Text>
      )}
      {progress?.stage === "pending" && <Text>Waiting for you to enter the code…</Text>}
      {progress?.stage === "code" && (
        <Card withBorder>
          <Stack>
            <Text>Open{" "}
              <Anchor href={progress.verificationUri} target="_blank" rel="noreferrer">
                {progress.verificationUri.replace("https://www.", "")}
              </Anchor>{" "}
              and enter this code:
            </Text>
            <Code fz="xl">{progress.userCode}</Code>
          </Stack>
        </Card>
      )}
      {(progress === null || progress.stage === "error" || progress.stage === "ok") && (
        <Button w={220} onClick={() => void api.post("/api/twitch/login")}>
          Sign in to Twitch
        </Button>
      )}
    </Stack>
  );
}
