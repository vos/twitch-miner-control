import { Anchor, Box, Button, Card, Center, PasswordInput, Stack, Text } from "@mantine/core";
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
  /**
   * Called once a fresh session exists. Lets the live stream -- which
   * parks itself for good when it decides the cookie is dead -- start
   * over, instead of leaving a logged-in dashboard with no updates.
   */
  onUnlocked?: () => void;
}

export function PasswordGate({
  children,
  sessionExpired = false,
  onUnlocked,
}: PasswordGateProps) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Bumped on each failure to restart the shake animation -- re-rendering
  // with the same key would leave a finished animation finished.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    api.get("/api/status")
      // The probe was fired before any expiry could be reported, so its
      // answer must not overrule one that arrived while it was in flight
      // -- that would unlock the app on a cookie known to be dead.
      .then(() => setUnlocked((prev) => (prev === false ? prev : true)))
      .catch(() => setUnlocked(false));
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

  /**
   * A reported expiry re-locks the app.
   *
   * Handled here rather than by gating the render on `sessionExpired`: that
   * read made the flag outrank everything that happened after it, so a
   * stream 401ing before the user finished typing (every fresh load with no
   * cookie) swallowed the login that followed -- the form appeared to do
   * nothing, and only a manual refresh got the dashboard up. Folding it into
   * state instead lets the newer event win.
   *
   * The password is cleared only when a session was actually on screen.
   * On a fresh load with no cookie the stream 401s and reports an expiry
   * a few seconds in, while the user is partway through typing -- and
   * clearing it there wiped the field under them. Dropping the old
   * password belongs to ending a session that existed, not to news about
   * one that never did.
   *
   * The lock itself still applies unconditionally, including before the
   * mount probe has answered: that probe defers to a known expiry rather
   * than overruling it, so leaving `unlocked` alone here would let a
   * 200 land after this and unlock a cookie already known to be dead.
   */
  useEffect(() => {
    if (!sessionExpired) return;
    // Read rather than branch inside the updater: StrictMode invokes
    // updaters twice, so they have to stay pure.
    if (unlocked === true) {
      setPassword("");
      setError(null);
    }
    setUnlocked(false);
  }, [sessionExpired]);

  if (unlocked === null) return null;
  if (unlocked) {
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
      onUnlocked?.();
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
          {/* The stack's own gap keeps the title and its subtitle tight as
              one block, so the breathing room the mark needs at this size
              is set here rather than by widening that gap for all three. */}
          <Box mb="md">
            <BrandMark size={250} />
          </Box>
          <Text fw={700} size="xl" style={{ letterSpacing: "0.1em" }}>
            TWITCH MINER CONTROL
          </Text>
          {/* One sentence, two tones: the framing words recede so the
              upstream project's name is what the eye lands on. */}
          <Text size="sm" c="dimmed">
            a control panel for{" "}
            <Text span inherit c="var(--mantine-color-text)">
              Twitch Channel Points Miner
            </Text>
          </Text>
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
        {/* The subtitle above already names the miner, so this credits
            its author and links out instead of repeating the sentence.
            Dimmed a step below: findable on the way out, not competing
            with the password field. */}
        <Text size="xs" c="dimmed" ta="center">
          Miner by mpforce1 —{" "}
          <Anchor
            href="https://github.com/mpforce1/Twitch-Channel-Points-Miner"
            target="_blank"
            rel="noreferrer"
            inherit
            // "view on GitHub" alone is meaningless in a screen
            // reader's list of links, which strips the sentence.
            aria-label="Twitch Channel Points Miner on GitHub"
          >
            view on GitHub
          </Anchor>
        </Text>
      </Stack>
    </Center>
  );
}
