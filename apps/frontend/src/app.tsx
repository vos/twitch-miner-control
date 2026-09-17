import { AppShell, Burger, Group, Text, Tooltip } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { useEffect, useRef, useState } from "react";
import { api } from "./api/client.js";
import { LiveStateProvider, useLiveState, useStreamEvent } from "./api/useLiveState.js";
import {
  RestartBanner, type PendingRestartState,
} from "./components/RestartBanner.js";
import { MinerStatusBadge, type MinerStatus } from "./components/MinerStatusBadge.js";
import { PasswordGate } from "./components/PasswordGate.js";
import { useSession } from "./components/session.js";
import { Sidebar } from "./components/Sidebar.js";
import { type ProcSample, useRollingHistory } from "./lib/rollingHistory.js";
import { useLocalToggle } from "./lib/useLocalToggle.js";
import { Dashboard } from "./routes/Dashboard.js";
import { Drops } from "./routes/Drops.js";
import { TwitchLogin } from "./routes/Login.js";
import { Logs } from "./routes/Logs.js";
import { Settings } from "./routes/Settings.js";
import { Streamers } from "./routes/Streamers.js";

/**
 * `element` is a function rather than a built element so a screen can be
 * handed props from Shell's own state -- the dashboard needs the Twitch
 * login status and a way to navigate. It also stops every screen being
 * constructed on each render when only one of them is shown.
 */
const SCREENS = {
  dashboard: {
    label: "Dashboard",
    element: (p: ScreenProps) => (
      <Dashboard loginRequired={p.loginRequired} onSignIn={() => p.navigate("account")} />
    ),
  },
  streamers: { label: "Streamers", element: () => <Streamers /> },
  drops: { label: "Drops", element: () => <Drops /> },
  logs: { label: "Logs", element: () => <Logs /> },
  settings: { label: "Settings", element: () => <Settings /> },
  account: { label: "Twitch account", element: () => <TwitchLogin /> },
} as const;

interface ScreenProps {
  loginRequired: boolean;
  navigate: (key: ScreenKey) => void;
}

export type ScreenKey = keyof typeof SCREENS;

/** The parts of /api/status, and of each status frame, that the shell reads. */
interface Status {
  miner: string;
  loginRequired: boolean;
  startedAt: number | null;
  stats: { cpu: number | null; rssBytes: number } | null;
  version?: string;
  latestVersion?: string | null;
  /** Optional: a backend predating the drops engine sends no such field. */
  pendingRestart?: PendingRestartState;
}

export function App() {
  return (
    <PasswordGate>
      <LiveStateProvider>
        <Shell />
      </LiveStateProvider>
    </PasswordGate>
  );
}

/**
 * Everything behind the gate, split out of App so none of it mounts until
 * the gate is unlocked -- the status load and the live stream would
 * otherwise run against the password screen, 401ing all the while. Locking
 * unmounts it again, which closes the stream; the next unlock starts a
 * fresh one.
 */
function Shell() {
  const { onLoggedOut } = useSession();
  const [screen, setScreen] = useState<ScreenKey>("dashboard");
  // One value rather than two pieces of state, so a status update can never
  // land a new state beside the previous run's start time -- which would
  // render a STOPPED badge next to a still-ticking uptime.
  // state: null until the first status arrives -- see MinerStatus. A
  // placeholder string would read as a real state to every control that
  // checks one.
  const [miner, setMiner] = useState<MinerStatus>({ state: null, startedAt: null });
  // true until the first status arrives, matching the server's own
  // default-to-required stance.
  const [loginRequired, setLoginRequired] = useState(true);
  // Whether that default has actually been confirmed by the server yet.
  // The dashboard notice is keyed on this as well as on `loginRequired`:
  // acting on the unproven default alone would flash "Twitch sign-in
  // needed" at every signed-in user on every load. The sidebar dot can
  // live with it -- a two-pixel circle blinking is not a false alarm the
  // way a titled alert is.
  const [loginKnown, setLoginKnown] = useState(false);
  // The newest process-stats reading. The rolling window it feeds lives
  // in a ref (see useRollingHistory), so only this one value is state.
  const [stats, setStats] = useState<ProcSample | null>(null);
  // Fixed for the life of the server process, but it arrives with the
  // status rather than from a build-time constant: the frontend is
  // served by that same backend, so this reports what is actually
  // running rather than what the bundle was built from.
  const [version, setVersion] = useState<string | null>(null);
  // A release newer than the one running, or null when there is nothing
  // to offer. The backend does the comparing -- see updateCheck.ts -- so
  // this is only ever a version to show or nothing at all.
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [pendingRestart, setPendingRestart] = useState<PendingRestartState>({
    pending: false, dueAt: null, reason: null,
  });
  const [opened, { toggle, close }] = useDisclosure(false);
  // The wide-screen counterpart of `opened`. AppShell keeps the two
  // collapse states apart -- the narrow one slides a drawer over the page,
  // the wide one takes the navbar out and lets the content have its width
  // -- so one flag cannot drive both without the hidden one surfacing at
  // the wrong size after a resize.
  const [deskCollapsed, toggleDesk] = useLocalToggle("tw.sidebarCollapsed", false);
  // Which of the two the burger drives. Matches AppShell's own `sm`
  // breakpoint below, so the control always acts on the sidebar the user
  // is actually looking at. Measured during the first render rather than
  // in an effect (the hook's default): deferring it returns `undefined`
  // once, which would paint the burger in its narrow-screen state for a
  // frame and flash the icon on every desktop load.
  const wide = useMediaQuery("(min-width: 48em)", false, { getInitialValueInEffect: false });
  // Drives the live-count badge in the nav and the header's connection
  // dot. `connected` is computed by the hook from EventSource's own
  // lifecycle and, before this, was read nowhere -- so a dropped stream
  // looked exactly like a healthy one.
  const { snapshot, connected, authExpired } = useLiveState();

  // The stream only learns this with a session already on screen, so the
  // server has logged the user out and the gate should say so.
  useEffect(() => {
    if (authExpired) onLoggedOut();
  }, [authExpired, onLoggedOut]);

  const applyStatus = (s: Status) => {
    setMiner({ state: s.miner, startedAt: s.startedAt });
    setLoginRequired(s.loginRequired);
    setLoginKnown(true);
    // Optional, so a backend that predates the field renders no
    // readout rather than the string "undefined".
    setVersion(s.version ?? null);
    setLatestVersion(s.latestVersion ?? null);
    // Stamped on arrival: the history uses this to tell a fresh
    // reading from a re-render carrying the same one.
    setStats(s.stats === null ? null : { ...s.stats, at: Date.now() });
    // Carried on the status frame as well as its own event, so a tab
    // opened mid-countdown shows the banner rather than nothing.
    if (s.pendingRestart !== undefined) setPendingRestart(s.pendingRestart);
  };

  // The engine pushes this the moment it proposes or cancels, rather
  // than leaving the banner until the next status tick.
  useStreamEvent<PendingRestartState>("pending-restart", setPendingRestart);

  // The server pushes a status whenever the miner or the Twitch session
  // changes, and on a tick for the process stats. Set once one has arrived,
  // so the mount-time load below cannot land after it and roll it back.
  const pushed = useRef(false);
  useStreamEvent<Status>("status", (s) => {
    pushed.current = true;
    applyStatus(s);
  });

  // Frames only start once the stream is open, so the header would sit
  // empty until the first tick without this.
  useEffect(() => {
    api.get<Status>("/api/status")
      .then((s) => { if (!pushed.current) applyStatus(s); })
      .catch(() => undefined);
  }, []);

  const statsHistory = useRollingHistory(stats);

  const liveCount = snapshot?.streamers.filter((s) => s.isOnline).length ?? 0;

  const navigate = (key: ScreenKey) => {
    setScreen(key);
    // On mobile the sidebar is a slide-over; leaving it open over the
    // screen the user just chose hides the thing they navigated to. The
    // wide-screen sidebar covers nothing, so it stays as the user set it.
    close();
  };

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: 240,
        breakpoint: "sm",
        collapsed: { mobile: !opened, desktop: deskCollapsed },
      }}
      padding="lg"
    >
      <AppShell.Header bg="var(--tw-surface)" style={{ borderColor: "var(--tw-border)" }}>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={wide ? !deskCollapsed : opened}
              onClick={wide ? toggleDesk : toggle}
              aria-label="Toggle sidebar"
              size="sm"
            />
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
          version={version}
          latestVersion={latestVersion}
        />
      </AppShell.Navbar>
      <AppShell.Main>
        {/* Above the screen, not inside one: the restart affects the
            miner whatever the user happens to be looking at. */}
        <RestartBanner
          state={pendingRestart}
          onCancel={() => { void api.post("/api/restart/cancel"); }}
          onNow={() => { void api.post("/api/restart/now"); }}
        />
        {SCREENS[screen].element({
          loginRequired: loginRequired && loginKnown,
          navigate,
        })}
      </AppShell.Main>
    </AppShell>
  );
}
