import { AppShell, Badge, Group, NavLink, Title } from "@mantine/core";
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

  useEffect(() => {
    const load = () =>
      api.get<{ miner: string }>("/api/status")
        .then((s) => setMinerState(s.miner))
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
        <AppShell.Main>{SCREENS[screen].element}</AppShell.Main>
      </AppShell>
    </PasswordGate>
  );
}
