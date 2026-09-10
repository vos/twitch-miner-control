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
  bet: "bet",
  simulateHlsPlayback: "simulate_hls_playback",
};

/**
 * Key renames *inside* the nested settings objects, keyed by the camelCase
 * name of the object itself. A flat one-level rename would leave these
 * untouched and hand Python a dict whose inner keys StreamerSettings
 * rejects -- which is why the mappers below recurse.
 */
export const NESTED_TO_PYTHON: Record<string, Record<string, string>> = {
  bet: {
    strategy: "strategy",
    percentage: "percentage",
    percentageGap: "percentage_gap",
    maxPoints: "max_points",
    minimumPoints: "minimum_points",
    stealthMode: "stealth_mode",
    delay: "delay",
    delayMode: "delay_mode",
    filterCondition: "filter_condition",
  },
  filterCondition: { by: "by", where: "where", value: "value" },
  simulateHlsPlayback: { refreshBefore: "refresh_before" },
};

/** Upstream marks DECISION_USERS/DECISION_POINTS as keys that do not exist. */
export const OUTCOME_KEYS = [
  "percentage_users", "odds_percentage", "odds",
  "top_points", "total_users", "total_points",
] as const;

export const STRATEGIES = [
  "MOST_VOTED", "HIGH_ODDS", "PERCENTAGE", "SMART_MONEY", "SMART",
  "NUMBER_1", "NUMBER_2", "NUMBER_3", "NUMBER_4",
  "NUMBER_5", "NUMBER_6", "NUMBER_7", "NUMBER_8",
] as const;

const filterConditionSchema = z
  .object({
    by: z.enum(OUTCOME_KEYS),
    where: z.enum(["GT", "LT", "GTE", "LTE"]),
    value: z.number(),
  })
  .strict();

const betSchema = z
  .object({
    strategy: z.enum(STRATEGIES).optional(),
    percentage: z.number().int().min(0).max(100).optional(),
    percentageGap: z.number().int().min(0).max(100).optional(),
    maxPoints: z.number().int().nonnegative().optional(),
    minimumPoints: z.number().int().nonnegative().optional(),
    stealthMode: z.boolean().optional(),
    delay: z.number().nonnegative().optional(),
    delayMode: z.enum(["FROM_START", "FROM_END", "PERCENTAGE"]).optional(),
    filterCondition: filterConditionSchema.optional(),
  })
  .strict();

const hlsSchema = z
  .union([
    z.literal(false),
    z.object({ refreshBefore: z.number().int().positive() }).strict(),
  ]);

const settingsSchema = z
  .object({
    ...Object.fromEntries(BOOL_SETTINGS.map((k) => [k, z.boolean().optional()])),
    pointsLimit: z.union([z.literal(false), z.number().int().positive()]).optional(),
    chat: z.enum(["ALWAYS", "NEVER", "ONLINE", "OFFLINE"]).optional(),
    bet: betSchema.optional(),
    simulateHlsPlayback: hlsSchema.optional(),
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

/**
 * Renames one level of keys, recursing into the nested settings objects
 * named in NESTED_TO_PYTHON. `false` is a legal value for
 * simulateHlsPlayback and must survive as a bare false rather than being
 * treated as an object to walk.
 */
function renameKeys(
  input: Record<string, unknown>,
  map: Record<string, string>,
  nested: Record<string, Record<string, string>>,
  nestedKeyOf: (camelOrSnake: string) => string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      const renamed = map[key] ?? key;
      const childMap = nested[nestedKeyOf(key)];
      if (childMap && value !== null && typeof value === "object") {
        return [renamed, renameKeys(
          value as Record<string, unknown>, childMap, nested, nestedKeyOf,
        )];
      }
      return [renamed, value];
    }),
  );
}

const invert = (map: Record<string, string>) =>
  Object.fromEntries(Object.entries(map).map(([a, b]) => [b, a]));

export function settingsToPython(settings: Record<string, unknown>) {
  return renameKeys(settings, TO_PYTHON, NESTED_TO_PYTHON, (k) => k);
}

export function settingsFromPython(raw: Record<string, unknown>) {
  const back = invert(TO_PYTHON);
  const nestedBack = Object.fromEntries(
    Object.entries(NESTED_TO_PYTHON).map(([k, v]) => [k, invert(v)]),
  );
  return renameKeys(raw, back, nestedBack, (k) => back[k] ?? k);
}
