import { z } from "zod";

/** Mirrors miner_config.ALLOWED_SETTINGS. Keep both in sync. */
export const BOOL_SETTINGS = [
  "makePredictions", "followRaid", "claimDrops", "claimMoments",
  "watchStreak", "communityGoals", "weeklyRewards",
] as const;

export const TO_PYTHON: Record<string, string> = {
  makePredictions: "make_predictions",
  followRaid: "follow_raid",
  claimDrops: "claim_drops",
  claimMoments: "claim_moments",
  watchStreak: "watch_streak",
  communityGoals: "community_goals",
  weeklyRewards: "weekly_rewards",
  pointsLimit: "points_limit",
  chat: "chat",
};

const settingsSchema = z
  .object({
    ...Object.fromEntries(BOOL_SETTINGS.map((k) => [k, z.boolean().optional()])),
    pointsLimit: z.union([z.literal(false), z.number().int().positive()]).optional(),
    chat: z.enum(["ALWAYS", "NEVER", "ONLINE", "OFFLINE"]).optional(),
  })
  .strict();

/** Twitch login rules: 4-25 chars, letters/digits/underscore. */
export const usernameSchema = z.string().regex(/^[a-zA-Z0-9_]{4,25}$/);

/**
 * The account username, which is allowed to be *unset* on a fresh install.
 *
 * `DEFAULT_CONFIG` (config/store.ts) is what `loadConfig()` returns before
 * `config.json` exists, and the UI's first run reads that object, edits it
 * and writes it straight back. Requiring a real Twitch login here made the
 * value the API hands out a value the API refuses to take back: PUT
 * /api/config answered the untouched defaults with a 400, so a fresh
 * install could not be configured through the UI at all. The empty string
 * is therefore a legitimate stored state meaning "no Twitch account chosen
 * yet" -- `/api/status` reports `loginRequired` for it, and index.ts
 * refuses to start the miner without it. Streamer usernames keep the
 * strict rule: there is no such thing as an unnamed streamer.
 */
export const accountUsernameSchema = z.union([z.literal(""), usernameSchema]);

export const configSchema = z
  .object({
    version: z.literal(1),
    username: accountUsernameSchema,
    followers: z.boolean(),
    followersOrder: z.enum(["ASC", "DESC"]),
    defaults: settingsSchema,
    streamers: z
      .array(
        z.object({
          username: usernameSchema,
          enabled: z.boolean(),
          settings: settingsSchema,
        }).strict(),
      )
      .refine(
        (list) => new Set(list.map((s) => s.username.toLowerCase())).size === list.length,
        { message: "duplicate streamer" },
      ),
  })
  .strict();

export type AppConfig = z.infer<typeof configSchema>;
export type StreamerSettingsInput = z.infer<typeof settingsSchema>;

export function settingsToPython(settings: StreamerSettingsInput) {
  return Object.fromEntries(
    Object.entries(settings).map(([k, v]) => [TO_PYTHON[k] ?? k, v]),
  );
}

export function settingsFromPython(raw: Record<string, unknown>) {
  const back = Object.fromEntries(Object.entries(TO_PYTHON).map(([a, b]) => [b, a]));
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [back[k] ?? k, v]),
  );
}
