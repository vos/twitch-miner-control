import { Badge, Box, Divider, Group, Stack, Text } from "@mantine/core";
import {
  IconChartBar, IconDeviceTv, IconSettings, IconTerminal2, IconUserCircle,
} from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { ScreenKey } from "../app.js";
import { BrandMark } from "./BrandMark.js";
import { LogoutButton } from "./LogoutButton.js";
import { MinerDock } from "./MinerDock.js";
import type { MinerStatus } from "./MinerStatusBadge.js";
import { NavItem } from "./NavItem.js";

const ICON = { size: 20, stroke: 1.7 };

const ITEMS: Array<{ key: ScreenKey; label: string; icon: ReactNode }> = [
  { key: "dashboard", label: "Dashboard", icon: <IconChartBar {...ICON} /> },
  { key: "streamers", label: "Streamers", icon: <IconDeviceTv {...ICON} /> },
  { key: "logs", label: "Logs", icon: <IconTerminal2 {...ICON} /> },
  { key: "settings", label: "Settings", icon: <IconSettings {...ICON} /> },
  { key: "account", label: "Twitch account", icon: <IconUserCircle {...ICON} /> },
];

export function Sidebar({
  screen, onNavigate, liveCount, loginRequired, miner, onMinerChange,
}: {
  screen: ScreenKey;
  onNavigate: (key: ScreenKey) => void;
  liveCount: number;
  loginRequired: boolean;
  miner: MinerStatus;
  onMinerChange: (status: MinerStatus) => void;
}) {
  return (
    <Stack h="100%" gap={0} justify="space-between">
      <Box>
        <Group gap="sm" px="md" py="lg" wrap="nowrap">
          <BrandMark size={40} />
          <Text fw={700} size="sm" style={{ letterSpacing: "0.08em" }}>
            MINER CONTROL
          </Text>
        </Group>
        <Stack gap={2} pr="xs">
          {ITEMS.map((item) => (
            <NavItem
              key={item.key}
              icon={item.icon}
              label={item.label}
              active={screen === item.key}
              onClick={() => onNavigate(item.key)}
              badge={
                item.key === "streamers" && liveCount > 0 ? (
                  <Badge size="sm" variant="filled" color="red" data-testid="nav-live-count">
                    {liveCount}
                  </Badge>
                ) : item.key === "account" && loginRequired ? (
                  // Replaces the alert banner that used to sit above every
                  // screen: the same warning, stated permanently, without
                  // consuming vertical space on the dashboard.
                  <Badge
                    size="xs" circle variant="filled" color="twitch"
                    data-testid="nav-login-required"
                    aria-label="Twitch sign-in needed"
                  >
                    {" "}
                  </Badge>
                ) : undefined
              }
            />
          ))}
        </Stack>
      </Box>
      <Box p="md" style={{ borderTop: "1px solid var(--tw-border)" }}>
        <Stack gap="xs">
          <MinerDock state={miner.state} onChange={onMinerChange} />
          {/* Set apart from the miner actions: this one ends the browser
              session and touches nothing the miner is doing. */}
          <Divider my={4} color="var(--tw-border)" />
          <LogoutButton />
        </Stack>
      </Box>
    </Stack>
  );
}
