import type { AppConfig, DropsMode } from "../config/schema.js";
import { normaliseUsername } from "./roster.js";

/**
 * The claim_drops mode the miner runs a channel in.
 *
 * Resolved the way the miner resolves it: a streamer's own setting wins,
 * otherwise the defaults apply -- which is also how a followed channel
 * with no config entry of its own gets its settings.
 *
 * Unset anywhere is LINKED, because that is what the miner does with it:
 * StreamerSettings maps an unset claim_drops to DropsMode.LINKED. Reading
 * absent as "off" here made the dashboard report no drops at all for a
 * default config -- every streamer inherits nothing -- while the miner
 * beside it was claiming drops for all of them.
 */
export function dropsMode(config: AppConfig, username: string): DropsMode {
  const login = normaliseUsername(username);
  const entry = config.streamers.find(
    (s) => normaliseUsername(s.username) === login,
  );
  return entry?.settings?.claimDrops ?? config.defaults.claimDrops ?? "LINKED";
}

/**
 * Whether the miner is claiming drops for this channel.
 *
 * The precondition for fetching drop data at all. Both LINKED and ALL
 * count: the miner syncs a channel's campaigns for anything but NONE
 * (StreamSystem.update_campaigns), and LINKED only narrows which of them
 * it then progresses. With the setting off a badge would be reporting on
 * something the miner is not doing.
 */
export function dropsEligible(config: AppConfig, username: string): boolean {
  return dropsMode(config, username) !== "NONE";
}
