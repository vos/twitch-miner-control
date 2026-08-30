import { Alert, AppShell, Badge, Button, Group, NavLink, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "./api/client.js";
import { PasswordGate } from "./components/PasswordGate.js";
import { Dashboard } from "./routes/Dashboard.js";
import { TwitchLogin } from "./routes/Login.js";
import { Logs } from "./routes/Logs.js";
import { Settings } from "./routes/Settings.js";
import { Streamers } from "./routes/Streamers.js";

const SCREENS = {
  dashboard: { label: "Dashboard", element: <Dashboard /> },
  streamers: { label: "Streamers", element: <Streamers /> },
  logs: { label: "Logs", element: <Logs /> },
  settings: { label: "Settings", element: <Settings /> },
  account: { label: "Twitch account", element: <TwitchLogin /> },
} as const;

export function App() {
  const [screen, setScreen] = useState<keyof typeof SCREENS>("dashboard");
  const [minerState, setMinerState] = useState("…");
  // I3: this used to be read nowhere in the frontend. `/api/status` already
  // reports it correctly (LoginStatus, not the login runner's own transient
  // progress -- see apps/backend/src/helpers/loginStatus.ts), so an expired
  // token showed up as a stale dashboard with a bare GQL error string and no
  // call to action. true until the first poll answers, matching the server's
  // own default-to-required stance.
  const [loginRequired, setLoginRequired] = useState(true);

  useEffect(() => {
    const load = () =>
      api.get<{ miner: string; loginRequired: boolean }>("/api/status")
        .then((s) => { setMinerState(s.miner); setLoginRequired(s.loginRequired); })
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <PasswordGate>
      <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: "sm" }} padding="md">
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between">
            <Title order={4}>Miner Control</Title>
            <Badge color={minerState === "RUNNING" ? "green" : "orange"}>{minerState}</Badge>
          </Group>
        </AppShell.Header>
        <AppShell.Navbar p="xs">
          {Object.entries(SCREENS).map(([key, { label }]) => (
            <NavLink
              key={key} label={label} active={screen === key}
              onClick={() => setScreen(key as keyof typeof SCREENS)}
            />
          ))}
        </AppShell.Navbar>
        <AppShell.Main>
          {loginRequired && screen !== "account" && (
            <Alert
              role="alert" color="yellow" mb="md" data-testid="login-required-banner"
              title="Twitch sign-in needed"
            >
              <Group justify="space-between" wrap="nowrap">
                <Text size="sm">
                  The miner cannot run without a signed-in Twitch account.
                </Text>
                <Button size="xs" onClick={() => setScreen("account")}>Sign in</Button>
              </Group>
            </Alert>
          )}
          {SCREENS[screen].element}
        </AppShell.Main>
      </AppShell>
    </PasswordGate>
  );
}
