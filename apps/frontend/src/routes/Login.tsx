import {
  Alert, Anchor, Button, Card, Group, Stack, Text, TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";

type Progress =
  | { stage: "code"; userCode: string; verificationUri: string; expiresAt: number }
  // Pending frames repeat the code fields so the card stays on screen
  // while the helper polls -- see code_fields in python/helpers/login.py.
  | { stage: "pending"; userCode?: string; verificationUri?: string; expiresAt?: number }
  | { stage: "ok"; username: string }
  | { stage: "error"; error: string }
  | null;

interface Config {
  version: 1; username: string; followers: boolean; followersOrder: string;
  defaults: Record<string, unknown>;
  streamers: Array<{ username: string; enabled: boolean; settings: Record<string, unknown> }>;
}

/** Mirrors usernameSchema in the backend's config/schema.ts. */
const USERNAME_RE = /^[a-zA-Z0-9_]{4,25}$/;

export function TwitchLogin() {
  const [progress, setProgress] = useState<Progress>(null);
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ login: Progress }>("/api/status")
      .then((s) => setProgress(s.login))
      .finally(() => setLoaded(true));
    api.get<Config>("/api/config")
      .then((c) => { setConfig(c); setUsername(c.username); })
      .catch(() => { /* the field stays empty and validates on submit */ });
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

  /**
   * The login helper reads TWITCH_USERNAME from the stored config at spawn
   * time (see helperEnv() in the backend's index.ts), so the name has to be
   * saved *before* the helper starts -- otherwise the device-code flow runs
   * against the previous value, or against "" on a fresh install, which
   * Twitch resolves to a null user.
   */
  const signIn = async () => {
    const name = username.trim();
    if (!USERNAME_RE.test(name)) {
      setError(
        "Enter your Twitch username: 4-25 characters, letters, digits or underscore.",
      );
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (config && config.username !== name) {
        await api.put("/api/config", { ...config, username: name });
        await api.post("/api/config/apply");
        setConfig({ ...config, username: name });
      }
      await api.post("/api/twitch/login");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return null;

  const idle = progress === null || progress.stage === "error" || progress.stage === "ok";

  return (
    <Stack>
      {error && <Alert role="alert" color="red">{error}</Alert>}
      {progress?.stage === "error" && (
        <Alert role="alert" color="red">{progress.error}</Alert>
      )}
      {progress?.stage === "ok" && (
        <Text>Signed in as {progress.username}</Text>
      )}
      {progress?.stage === "pending" && (
        <Group gap="xs">
          <span
            style={{
              width: 8, height: 8, borderRadius: "50%",
              background: "var(--tw-purple)", animation: "tw-pulse 1.6s ease-in-out infinite",
            }}
          />
          <Text size="sm" c="dimmed">Waiting for you to enter the code…</Text>
        </Group>
      )}
      {(progress?.stage === "code" || progress?.stage === "pending")
        && progress.userCode && progress.verificationUri && (
        <Card
          withBorder
          padding="lg"
          style={{ borderColor: "var(--tw-purple)", background: "rgba(145,71,255,0.06)" }}
        >
          <Stack align="center" gap="sm">
            <Text size="sm">Open{" "}
              <Anchor href={progress.verificationUri} target="_blank" rel="noreferrer">
                {progress.verificationUri.replace("https://www.", "")}
              </Anchor>{" "}
              and enter this code:
            </Text>
            <Text
              ff="monospace" fw={700}
              style={{ fontSize: 34, letterSpacing: "0.18em" }}
            >
              {progress.userCode}
            </Text>
            <Button
              size="xs" variant="light"
              onClick={() => void navigator.clipboard?.writeText(progress.userCode!)}
            >
              Copy code
            </Button>
            {progress.expiresAt !== undefined && <Countdown expiresAt={progress.expiresAt} />}
          </Stack>
        </Card>
      )}
      {idle && (
        <>
          <TextInput
            w={320}
            label="Twitch username"
            description="Your own account, not a streamer you want to mine."
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
          />
          <Button w={220} loading={busy} onClick={() => void signIn()}>
            Sign in to Twitch
          </Button>
        </>
      )}
    </Stack>
  );
}

/** Ticks so the operator can tell a fresh code from a dead one. */
function Countdown({ expiresAt }: { expiresAt: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  return (
    <Text size="xs" c={left < 60 ? "orange" : "dimmed"} data-testid="code-countdown">
      {left === 0 ? "Code expired — start again" : `Expires in ${mm}:${ss}`}
    </Text>
  );
}
