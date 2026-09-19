import { Tabs } from "@mantine/core";
import { AppLogView } from "../components/AppLogView.js";
import { MinerLogView } from "../components/MinerLogView.js";
import { useLocalChoice } from "../lib/useLocalChoice.js";

const TABS = ["miner", "app"] as const;

/**
 * Both logs, one page.
 *
 * Tabs rather than separate routes because the two halves answer the same
 * question from different sides -- the miner's output says what Twitch
 * did, the app events say what this backend decided about it -- and
 * reading a crash usually means looking at both. One keystroke apart
 * beats navigating between them.
 *
 * The choice is remembered: a reload landing back on the miner tab
 * mid-investigation is a small thing that happens every time.
 */
export function Logs() {
  const [tab, setTab] = useLocalChoice("tw.logsTab", "miner", TABS);

  return (
    <Tabs
      value={tab}
      onChange={(next) => setTab((next ?? "miner") as (typeof TABS)[number])}
      h="calc(100vh - 120px)"
      style={{ display: "flex", flexDirection: "column" }}
    >
      <Tabs.List mb="sm">
        <Tabs.Tab value="miner">Miner</Tabs.Tab>
        <Tabs.Tab value="app">App events</Tabs.Tab>
      </Tabs.List>

      {/* Mounted only while selected: each view holds an open subscription
          and a buffer, and the hidden one would keep both for nothing. */}
      <Tabs.Panel value="miner" style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {tab === "miner" && <MinerLogView />}
      </Tabs.Panel>
      <Tabs.Panel value="app" style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {tab === "app" && <AppLogView />}
      </Tabs.Panel>
    </Tabs>
  );
}
