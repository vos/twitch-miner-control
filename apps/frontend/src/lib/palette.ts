import type { StreamerState } from "../api/useLiveState.js";
import type { ScreenKey } from "../app.js";
import type { ResolvedCampaign } from "../components/CampaignCard.js";
import { matchesCampaign } from "./campaignMatch.js";
import { formatViewers } from "./formatViewers.js";
import { TRANSITIONAL, isKnown, isUp } from "./minerState.js";
import { parseStreamerInput } from "./parseStreamerInput.js";

export type MinerAction = "start" | "stop" | "restart";

export const MINER_LABEL: Record<MinerAction, string> = {
  start: "Start miner",
  stop: "Stop miner",
  restart: "Restart miner",
};

/** What choosing an item does. Kept as data so the builder stays pure. */
export type PaletteCommand =
  | { kind: "screen"; screen: ScreenKey }
  | { kind: "streamer"; login: string }
  | { kind: "campaign"; id: string }
  | { kind: "miner"; action: MinerAction }
  | { kind: "add"; login: string };

export interface PaletteItem {
  /** Unique across the palette, e.g. "streamer:alpha". */
  id: string;
  label: string;
  description?: string;
  /** Streamers only: live now. */
  live?: boolean;
  command: PaletteCommand;
}

export interface PaletteGroup {
  label: string;
  items: PaletteItem[];
}

type PaletteStreamer = Pick<StreamerState, "username" | "displayName" | "isOnline" | "viewers">;

export interface PaletteInput {
  query: string;
  screens: ReadonlyArray<{ key: ScreenKey; label: string }>;
  streamers: ReadonlyArray<PaletteStreamer>;
  /** Null until the catalogue has been fetched. */
  campaigns: ReadonlyArray<ResolvedCampaign> | null;
  minerState: string | null;
  now: number;
}

/** The most a search group shows: enough to pick from, few enough to scan. */
export const GROUP_LIMIT = 5;

const isLive = (s: PaletteStreamer) => s.isOnline === true;

/** Live first, the busiest of those first, then by name. */
function byLiveThenName(a: PaletteStreamer, b: PaletteStreamer): number {
  const live = Number(isLive(b)) - Number(isLive(a));
  if (live !== 0) return live;
  const viewers = (b.viewers ?? 0) - (a.viewers ?? 0);
  if (viewers !== 0) return viewers;
  return (a.displayName ?? a.username).localeCompare(b.displayName ?? b.username);
}

function streamerItem(s: PaletteStreamer): PaletteItem {
  const viewers = isLive(s) ? formatViewers(s.viewers ?? null) : null;
  return {
    id: `streamer:${s.username}`,
    label: s.displayName ?? s.username,
    description: !isLive(s) ? undefined : viewers === null ? "Live" : `Live · ${viewers} viewers`,
    live: isLive(s),
    command: { kind: "streamer", login: s.username },
  };
}

function minerItems(state: string | null): PaletteItem[] {
  // Unknown is not stopped, and a transitional miner has no safe action:
  // the same rules the sidebar's MinerDock follows.
  if (!isKnown(state) || TRANSITIONAL.has(state)) return [];
  const actions: MinerAction[] = isUp(state) ? ["stop", "restart"] : ["start"];
  return actions.map((action): PaletteItem => ({
    id: `miner:${action}`,
    label: MINER_LABEL[action],
    command: { kind: "miner", action },
  }));
}

const hasEnded = (c: ResolvedCampaign, now: number) => c.endsAt !== null && c.endsAt <= now;

function campaignItem(c: ResolvedCampaign, now: number): PaletteItem {
  const parts = [c.game?.displayName ?? null, hasEnded(c, now) ? "ended" : null]
    .filter((part): part is string => part !== null);
  return {
    id: `campaign:${c.id}`,
    label: c.name,
    description: parts.length === 0 ? undefined : parts.join(" · "),
    command: { kind: "campaign", id: c.id },
  };
}

const nonEmpty = (groups: PaletteGroup[]) => groups.filter((g) => g.items.length > 0);

/**
 * The palette's contents for a query.
 *
 * With nothing typed it offers somewhere to go, who is live and what the
 * miner can do. Once something is typed, what was searched for comes
 * first, then navigation, then the offer to add the query as a streamer.
 */
export function buildPalette(input: PaletteInput): PaletteGroup[] {
  const needle = input.query.trim().toLowerCase();
  const matches = (text: string | null) => text !== null && text.toLowerCase().includes(needle);

  const screens = input.screens
    .filter((s) => needle === "" || matches(s.label))
    .map((s): PaletteItem => ({
      id: `screen:${s.key}`, label: s.label, command: { kind: "screen", screen: s.key },
    }));

  const streamers = input.streamers
    .filter((s) => (needle === "" ? isLive(s) : matches(s.username) || matches(s.displayName)))
    .toSorted(byLiveThenName)
    .slice(0, GROUP_LIMIT)
    .map(streamerItem);

  const miner = minerItems(input.minerState).filter((i) => needle === "" || matches(i.label));

  if (needle === "") {
    return nonEmpty([
      { label: "Go to", items: screens },
      { label: "Live now", items: streamers },
      { label: "Actions", items: miner },
    ]);
  }

  const campaigns = (input.campaigns ?? [])
    .filter((c) => matchesCampaign(c, needle))
    .toSorted((a, b) =>
      Number(hasEnded(a, input.now)) - Number(hasEnded(b, input.now))
      || a.name.localeCompare(b.name))
    .slice(0, GROUP_LIMIT)
    .map((c) => campaignItem(c, input.now));

  const login = parseStreamerInput(input.query);
  const tracked = login !== null
    && input.streamers.some((s) => s.username.toLowerCase() === login.toLowerCase());
  const add: PaletteItem[] = login === null || tracked ? [] : [{
    id: `add:${login}`,
    label: `Add “${login}” as a streamer`,
    command: { kind: "add", login },
  }];

  return nonEmpty([
    { label: "Streamers", items: streamers },
    { label: "Campaigns", items: campaigns },
    { label: "Actions", items: miner },
    { label: "Go to", items: screens },
    // Last of all: almost any word is a valid login, and Enter takes the
    // first item, so anywhere higher it would beat a real match -- "logs"
    // would add a streamer instead of opening Logs.
    { label: "Add", items: add },
  ]);
}
