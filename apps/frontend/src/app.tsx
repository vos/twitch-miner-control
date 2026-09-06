import { AppShell, Burger, Group, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useEffect, useState } from "react";
import { api } from "./api/client.js";
import { useLiveState } from "./api/useLiveState.js";
import { MinerStatusBadge, type MinerStatus } from "./components/MinerStatusBadge.js";
import { PasswordGate } from "./components/PasswordGate.js";
import { Sidebar } from "./components/Sidebar.js";
import { type ProcSample, useRollingHistory } from "./lib/rollingHistory.js";
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

export type ScreenKey = keyof typeof SCREENS;

export function App() {
  const [screen, setScreen] = useState<ScreenKey>("dashboard");
  // One value rather than two pieces of state, so a status update can never
  // land a new state beside the previous run's start time -- which would
  // render a STOPPED badge next to a still-ticking uptime.
  const [miner, setMiner] = useState<MinerStatus>({ state: "…", startedAt: null });
  // true until the first poll answers, matching the server's own
  // default-to-required stance.
  const [loginRequired, setLoginRequired] = useState(true);
  // The newest process-stats reading. The rolling window it feeds lives
  // in a ref (see useRollingHistory), so only this one value is state.
  const [stats, setStats] = useState<ProcSample | null>(null);
  const [opened, { toggle, close }] = useDisclosure(false);
  // Drives the live-count badge in the nav and the header's connection
  // dot. `connected` is computed by the hook from EventSource's own
  // lifecycle and, before this, was read nowhere -- so a dropped stream
  // looked exactly like a healthy one.
  const { snapshot, connected, authExpired, retry } = useLiveState();

  useEffect(() => {
    const load = () =>
      api.get<{
        miner: string;
        loginRequired: boolean;
        startedAt: number | null;
        stats: { cpu: number | null; rssBytes: number } | null;
      }>("/api/status")
        .then((s) => {
          setMiner({ state: s.miner, startedAt: s.startedAt });
          setLoginRequired(s.loginRequired);
          // Stamped on arrival: the history uses this to tell a fresh
          // reading from a re-render carrying the same one.
          setStats(s.stats === null ? null : { ...s.stats, at: Date.now() });
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  const statsHistory = useRollingHistory(stats);

  const liveCount = snapshot?.streamers.filter((s) => s.isOnline).length ?? 0;

  const navigate = (key: ScreenKey) => {
    setScreen(key);
    // On mobile the sidebar is a slide-over; leaving it open over the
    // screen the user just chose hides the thing they navigated to.
    close();
  };

  return (
    <PasswordGate sessionExpired={authExpired} onUnlocked={retry}>
      <AppShell
        header={{ height: 56 }}
        navbar={{ width: 240, breakpoint: "sm", collapsed: { mobile: !opened } }}
        padding="lg"
      >
        <AppShell.Header bg="var(--tw-surface)" style={{ borderColor: "var(--tw-border)" }}>
          <Group h="100%" px="md" justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
              <Text fw={600}>{SCREENS[screen].label}</Text>
            </Group>
            <Group gap="sm" wrap="nowrap">
              <Tooltip label={connected ? "Live updates connected" : "Live updates disconnected"}>
                <span
                  data-testid="stream-connected"
                  aria-label={connected ? "Live updates connected" : "Live updates disconnected"}
                  style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: connected ? "var(--tw-success)" : "var(--tw-text-dim)",
                  }}
                />
              </Tooltip>
              <MinerStatusBadge
                state={miner.state}
                startedAt={miner.startedAt}
                history={statsHistory}
              />
            </Group>
          </Group>
        </AppShell.Header>
        <AppShell.Navbar bg="var(--tw-surface)" style={{ borderColor: "var(--tw-border)" }}>
          <Sidebar
            screen={screen}
            onNavigate={navigate}
            liveCount={liveCount}
            loginRequired={loginRequired}
            miner={miner}
            onMinerChange={setMiner}
          />
        </AppShell.Navbar>
        <AppShell.Main>{SCREENS[screen].element}</AppShell.Main>
      </AppShell>
    </PasswordGate>
  );
}
