import type { AppConfig } from "../config/schema.js";
import { normaliseUsername } from "./roster.js";

/**
 * Whether the miner is claiming drops for this channel.
 *
 * The precondition for fetching drop data at all. Upstream's
 * `should_sync_campaigns` requires `claim_drops` before it syncs a
 * streamer's campaigns, so with the setting off there is no inventory
 * progress to read and a badge would be reporting on something the
 * miner is not doing.
 *
 * Resolved the way the miner resolves it: a streamer's own setting wins,
 * otherwise the defaults apply -- which is also how a followed channel
 * with no config entry of its own gets its settings.
 *
 * Unset anywhere is ON, because that is what the miner does with it:
 * Streamer.default() sets claim_drops = True when it is None. Reading
 * absent as "off" here made the dashboard report no drops at all for a
 * default config -- every streamer inherits nothing -- while the miner
 * beside it was claiming drops for all of them.
 */
export function dropsEligible(config: AppConfig, username: string): boolean {
  const login = normaliseUsername(username);
  const entry = config.streamers.find(
    (s) => normaliseUsername(s.username) === login,
  );
  const own = claimDrops(entry?.settings);
  // `?? true` last: an explicit false at either level still wins, but
  // absent at both follows the miner's own default.
  return own ?? claimDrops(config.defaults) ?? true;
}

/**
 * Reads `claimDrops` off a settings object.
 *
 * The boolean settings are spread into settingsSchema from BOOL_SETTINGS
 * with Object.fromEntries, so Zod infers them as an index signature
 * rather than named keys -- the field is there at runtime but not on the
 * static type. This narrows in one place instead of casting at both call
 * sites, and returns undefined for "unset" so the caller can tell it
 * from an explicit false.
 */
function claimDrops(settings: object | undefined): boolean | undefined {
  const value = (settings as { claimDrops?: unknown } | undefined)?.claimDrops;
  return typeof value === "boolean" ? value : undefined;
}
