import { ActionIcon, Button, Group, Kbd, Loader, Text } from "@mantine/core";
import { useMediaQuery, useWindowEvent } from "@mantine/hooks";
import { Spotlight, createSpotlight } from "@mantine/spotlight";
import { IconSearch } from "@tabler/icons-react";
import { useState } from "react";
import { api } from "../api/client.js";
import { useLiveState } from "../api/useLiveState.js";
import type { ScreenKey } from "../app.js";
import {
  MINER_LABEL, buildPalette, type MinerAction, type PaletteCommand,
} from "../lib/palette.js";
import type { ScreenParams } from "../lib/screenIntent.js";
import type { CampaignsPayload } from "../routes/Drops.js";
import type { ResolvedCampaign } from "./CampaignCard.js";
import type { MinerStatus } from "./MinerStatusBadge.js";

/**
 * The palette's own store, so opening it never depends on which component
 * happens to hold a reference: the header button and the shortcut drive
 * the same instance.
 */
const [paletteStore, palette] = createSpotlight();
export { palette };

/** What a miner action will cost, said before it is taken. */
const PROMPT: Record<MinerAction, string> = {
  start: "Starting the miner…",
  stop: "Stop the miner? It will stop collecting points.",
  restart: "Restart the miner? Collection pauses while it comes back up.",
};

interface Pending {
  action: MinerAction;
  running: boolean;
  error: string | null;
}

const LIVE_DOT = (
  <span
    aria-hidden
    style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--tw-live)" }}
  />
);

export function CommandPalette({
  screens, minerState, onMinerChange, onNavigate, onOpenStreamer,
}: {
  screens: ReadonlyArray<{ key: ScreenKey; label: string }>;
  minerState: string | null;
  onMinerChange: (status: MinerStatus) => void;
  onNavigate: (key: ScreenKey, params?: ScreenParams) => void;
  onOpenStreamer: (login: string) => void;
}) {
  const { snapshot } = useLiveState();
  const [query, setQuery] = useState("");
  const [campaigns, setCampaigns] = useState<ResolvedCampaign[] | null>(null);
  const [asked, setAsked] = useState(false);
  // A miner action waiting on confirmation, running, or failed. While set,
  // the list is replaced by the confirmation and the query is ignored.
  const [pending, setPending] = useState<Pending | null>(null);

  // Fetched on the first open rather than on mount: most sessions never
  // open the palette, and the catalogue is the largest payload the app
  // reads. A failed fetch is asked again on the next open.
  const loadCampaigns = () => {
    if (asked) return;
    setAsked(true);
    api.get<CampaignsPayload>("/api/campaigns")
      .then((payload) => setCampaigns(payload.campaigns))
      .catch(() => setAsked(false));
  };

  const run = async (action: MinerAction) => {
    setPending({ action, running: true, error: null });
    try {
      onMinerChange(await api.post<MinerStatus>(`/api/miner/${action}`));
      palette.close();
    } catch (cause) {
      setPending({
        action, running: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const dispatch = (command: PaletteCommand) => {
    switch (command.kind) {
      case "screen": return onNavigate(command.screen);
      case "streamer": return onOpenStreamer(command.login);
      case "campaign": return onNavigate("drops", { campaign: command.id });
      case "add": return onNavigate("streamers", { prefill: command.login });
      case "miner":
        // Stopping costs points, so it is asked about. Starting costs
        // nothing and is simply done.
        if (command.action === "start") void run("start");
        else setPending({ action: command.action, running: false, error: null });
    }
  };

  // Escape backs out of a confirmation instead of closing the palette.
  // Listened for on the window because focus may be on the search box or
  // on an action; Spotlight's own Escape is off while this is showing.
  useWindowEvent("keydown", (event) => {
    if (event.key !== "Escape" || pending === null || pending.running) return;
    event.preventDefault();
    setPending(null);
  });

  const groups = buildPalette({
    query,
    screens,
    streamers: snapshot?.streamers ?? [],
    campaigns,
    minerState,
    now: Date.now(),
  });

  const confirmation = pending !== null && (
    <>
      <Text size="sm" px="md" py="xs" data-testid="palette-confirm-text">
        {PROMPT[pending.action]}
      </Text>
      {pending.error !== null && (
        <Text size="sm" c="red" px="md" pb="xs" role="alert" data-testid="palette-error">
          {pending.error}
        </Text>
      )}
      <Spotlight.Action
        label={pending.error === null ? MINER_LABEL[pending.action] : "Try again"}
        disabled={pending.running}
        rightSection={pending.running ? <Loader size="xs" /> : undefined}
        closeSpotlightOnTrigger={false}
        onClick={() => void run(pending.action)}
        data-testid="palette-confirm"
      />
      <Spotlight.Action
        label="Cancel"
        disabled={pending.running}
        closeSpotlightOnTrigger={false}
        onClick={() => setPending(null)}
        data-testid="palette-cancel"
      />
    </>
  );

  return (
    <Spotlight.Root
      store={paletteStore}
      query={query}
      onQueryChange={setQuery}
      shortcut="mod + K"
      // Ctrl+K is expected to work from inside a text field too.
      tagsToIgnore={[]}
      closeOnEscape={pending === null}
      onSpotlightOpen={loadCampaigns}
      onSpotlightClose={() => { setPending(null); setQuery(""); }}
      scrollable
      maxHeight={420}
    >
      <Spotlight.Search
        placeholder="Search streamers, campaigns, actions…"
        leftSection={<IconSearch size={18} stroke={1.7} />}
      />
      <Spotlight.ActionsList>
        {confirmation || (groups.length === 0
          ? <Spotlight.Empty>Nothing found</Spotlight.Empty>
          : groups.map((group) => (
            <Spotlight.ActionsGroup key={group.label} label={group.label}>
              {group.items.map((item) => (
                <Spotlight.Action
                  key={item.id}
                  label={item.label}
                  description={item.description}
                  leftSection={item.live ? LIVE_DOT : undefined}
                  highlightQuery
                  highlightColor="twitch"
                  // A miner action moves on to its confirmation or its
                  // progress, which the palette has to stay open to show.
                  closeSpotlightOnTrigger={item.command.kind !== "miner"}
                  onClick={() => dispatch(item.command)}
                  data-testid={`palette-${item.id}`}
                />
              ))}
            </Spotlight.ActionsGroup>
          )))}
      </Spotlight.ActionsList>
    </Spotlight.Root>
  );
}

/**
 * The palette's visible way in, for anyone who does not know the shortcut.
 *
 * Icon-only below the sidebar's breakpoint, where the header has no room
 * for a label.
 */
export function PaletteButton() {
  const wide = useMediaQuery("(min-width: 48em)", false, { getInitialValueInEffect: false });
  const mod = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

  if (!wide) {
    return (
      <ActionIcon
        variant="default" aria-label="Search" onClick={palette.open}
        data-testid="palette-button"
      >
        <IconSearch size={16} stroke={1.7} />
      </ActionIcon>
    );
  }
  return (
    <Button
      variant="default" size="xs"
      leftSection={<IconSearch size={14} stroke={1.7} />}
      rightSection={<Group gap={2} wrap="nowrap"><Kbd size="xs">{mod}</Kbd><Kbd size="xs">K</Kbd></Group>}
      onClick={palette.open}
      data-testid="palette-button"
    >
      Search…
    </Button>
  );
}
