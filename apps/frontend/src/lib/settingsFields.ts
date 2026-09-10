/**
 * Every per-streamer setting, described once.
 *
 * The streamer dialog and the global-defaults section both render from
 * this table, so adding an upstream setting is one entry here rather than
 * two hand-built forms that drift apart. `defaultValue` is upstream's own
 * default (StreamerSettings.default() / BetSettings.default()), which is
 * what a field falls back to when neither the streamer nor the global
 * defaults set it.
 */
export type TabId = "general" | "points" | "predictions";

export type FieldKind =
  | { kind: "bool" }
  | { kind: "enum"; options: readonly string[]; labels?: Record<string, string> }
  | { kind: "optionalNumber"; offValue: false; min?: number; offLabel: string }
  | { kind: "number"; min?: number; max?: number };

export interface SettingsField {
  key: string;
  label: string;
  help: string;
  tab: TabId;
  kind: FieldKind;
  defaultValue: unknown;
}

const bool = (
  key: string, label: string, help: string, tab: TabId, defaultValue: boolean,
): SettingsField => ({ key, label, help, tab, kind: { kind: "bool" }, defaultValue });

export const SETTINGS_FIELDS: SettingsField[] = [
  bool("makePredictions", "Make predictions",
    "Place channel-point bets on this streamer's predictions.", "general", true),
  bool("followRaid", "Follow raids",
    "Join raids from this channel to collect the raid bonus.", "general", true),
  bool("claimDrops", "Claim drops",
    "Count viewing time towards Twitch drop campaigns.", "general", true),
  bool("claimMoments", "Claim moments",
    "Claim Twitch Moments when this channel publishes one.", "general", true),
  bool("watchStreak", "Watch streaks",
    "Prioritise this channel when a watch streak is available.", "general", true),
  bool("communityGoals", "Community goals",
    "Contribute the maximum points per stream to community challenge goals.",
    "general", false),
  bool("weeklyRewards", "Weekly rewards",
    "Automatically progress this channel's weekly rewards.", "general", true),
  {
    key: "pointsLimit", label: "Points limit", tab: "points",
    help: "Stop mining this channel once its balance reaches this many points.",
    kind: { kind: "optionalNumber", offValue: false, min: 1, offLabel: "No limit" },
    defaultValue: false,
  },
  {
    key: "chat", label: "Chat presence", tab: "points",
    help: "Join the channel's IRC chat to increase watch time.",
    kind: {
      kind: "enum",
      options: ["ALWAYS", "NEVER", "ONLINE", "OFFLINE"],
      labels: { ALWAYS: "Always", NEVER: "Never", ONLINE: "Online", OFFLINE: "Offline" },
    },
    defaultValue: "ONLINE",
  },
  {
    key: "simulateHlsPlayback", label: "Simulate playback", tab: "points",
    help: "Fetch the stream like a real player, refreshing the access token this "
      + "many seconds before it expires. Off skips HLS simulation entirely.",
    kind: { kind: "optionalNumber", offValue: false, min: 1, offLabel: "Off" },
    defaultValue: false,
  },
];

export const BET_FIELDS: SettingsField[] = [
  {
    key: "strategy", label: "Strategy", tab: "predictions",
    help: "How to pick which outcome to bet on.",
    kind: {
      kind: "enum",
      options: ["MOST_VOTED", "HIGH_ODDS", "PERCENTAGE", "SMART_MONEY", "SMART",
        "NUMBER_1", "NUMBER_2", "NUMBER_3", "NUMBER_4",
        "NUMBER_5", "NUMBER_6", "NUMBER_7", "NUMBER_8"],
      labels: {
        MOST_VOTED: "Most voted", HIGH_ODDS: "High odds", PERCENTAGE: "Percentage",
        SMART_MONEY: "Smart money", SMART: "Smart",
        NUMBER_1: "Outcome 1", NUMBER_2: "Outcome 2", NUMBER_3: "Outcome 3",
        NUMBER_4: "Outcome 4", NUMBER_5: "Outcome 5", NUMBER_6: "Outcome 6",
        NUMBER_7: "Outcome 7", NUMBER_8: "Outcome 8",
      },
    },
    defaultValue: "SMART",
  },
  {
    key: "percentage", label: "Percentage", tab: "predictions",
    help: "Bet this percentage of your balance on the channel.",
    kind: { kind: "number", min: 0, max: 100 }, defaultValue: 5,
  },
  {
    key: "percentageGap", label: "Percentage gap", tab: "predictions",
    help: "Minimum gap between outcomes before the Smart strategy commits.",
    kind: { kind: "number", min: 0, max: 100 }, defaultValue: 20,
  },
  {
    key: "maxPoints", label: "Maximum points", tab: "predictions",
    help: "Cap on a single bet, whatever the percentage works out to.",
    kind: { kind: "number", min: 0 }, defaultValue: 50000,
  },
  {
    key: "minimumPoints", label: "Minimum balance", tab: "predictions",
    help: "Only bet when the channel balance is at least this high.",
    kind: { kind: "number", min: 0 }, defaultValue: 0,
  },
  bool("stealthMode", "Stealth mode",
    "Never out-bet the current top predictor; place just under instead.",
    "predictions", false),
  {
    key: "delay", label: "Delay", tab: "predictions",
    help: "Seconds used with the delay mode below to time the bet.",
    kind: { kind: "number", min: 0 }, defaultValue: 6,
  },
  {
    key: "delayMode", label: "Delay mode", tab: "predictions",
    help: "Whether the delay counts from the start of the window, from its end, "
      + "or as a fraction of it.",
    kind: {
      kind: "enum",
      options: ["FROM_START", "FROM_END", "PERCENTAGE"],
      labels: { FROM_START: "From start", FROM_END: "From end", PERCENTAGE: "Percentage" },
    },
    defaultValue: "FROM_END",
  },
];

/**
 * The three parts of a bet filter condition: "only bet when <by> <where>
 * <value>". Kept here rather than inline in the dialog so the option lists
 * have one frontend-side definition -- they mirror OUTCOME_KEYS and the
 * Condition enum in apps/backend/src/config/schema.ts, which the frontend
 * cannot import across the package boundary.
 *
 * Upstream marks DECISION_USERS/DECISION_POINTS as keys that do not exist,
 * so only the six real outcome keys are offered.
 */
export const FILTER_FIELDS: SettingsField[] = [
  {
    key: "by", label: "Measure", tab: "predictions",
    help: "Which property of the outcome to test.",
    kind: {
      kind: "enum",
      options: ["percentage_users", "odds_percentage", "odds",
        "top_points", "total_users", "total_points"],
      labels: {
        percentage_users: "Share of predictors (%)",
        odds_percentage: "Implied probability (%)",
        odds: "Odds",
        top_points: "Largest single bet",
        total_users: "Number of predictors",
        total_points: "Total points bet",
      },
    },
    defaultValue: "total_users",
  },
  {
    key: "where", label: "Comparison", tab: "predictions",
    help: "How the measure must compare to the value.",
    kind: {
      kind: "enum",
      options: ["GT", "LT", "GTE", "LTE"],
      labels: {
        GT: "is greater than", LT: "is less than",
        GTE: "is at least", LTE: "is at most",
      },
    },
    defaultValue: "LTE",
  },
  {
    key: "value", label: "Value", tab: "predictions",
    help: "The number the measure is compared against.",
    kind: { kind: "number", min: 0 },
    defaultValue: 800,
  },
];

/** Renders a field's upstream default as display text. */
export function describeDefault(field: SettingsField): string {
  const value = field.defaultValue;
  if (field.kind.kind === "optionalNumber" && value === false) {
    return field.kind.offLabel;
  }
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (field.kind.kind === "enum") {
    return field.kind.labels?.[String(value)] ?? String(value);
  }
  return String(value);
}
