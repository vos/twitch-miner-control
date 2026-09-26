import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { AppConfig } from "./schema.js";
import { configSchema, settingsFromPython, settingsToPython } from "./schema.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./store.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
  path = join(dir, "config.json");
});

// Left as a plain inferred literal (not typed `: AppConfig`) rather than
// annotated: settingsSchema's `defaults`/`streamers[].settings` shape is
// built via `Object.fromEntries(BOOL_SETTINGS.map(...))` (schema.ts), which
// TS cannot infer literal keys through, so a directly `AppConfig`-typed
// object literal here rejects `makePredictions` as an unknown property even
// though zod accepts it fine at runtime -- a pre-existing type-inference
// gap in schema.ts, unrelated to what this file tests. `as AppConfig` casts
// below (not excess-property-checked, since `valid` isn't a fresh literal
// at the cast site) get the saveConfig() calls, which need the narrower
// type, past it without touching schema.ts or any assertion in this file.
const valid = {
  version: 1,
  username: "alex",
  followers: true,
  followersOrder: "ASC",
  defaults: { makePredictions: false },
  miner: {},
  streamers: [{ username: "alpha", enabled: true, settings: {} }],
  subscriptions: [],
  followedGames: [],
  campaignQueue: false,
};

describe("schema", () => {
  test("accepts a valid config", () => {
    expect(configSchema.safeParse(valid).success).toBe(true);
  });

  test("rejects a username that cannot be a Twitch login", () => {
    const bad = { ...valid, streamers: [{ username: "a b!", enabled: true, settings: {} }] };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  test("rejects unknown settings keys so they cannot reach Python", () => {
    const bad = { ...valid, streamers: [{ username: "alpha", enabled: true, settings: { evil: 1 } }] };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  test("defaults subscriptions to an empty list", () => {
    const parsed = configSchema.parse(valid);
    expect(parsed.subscriptions).toEqual([]);
  });

  test("accepts a campaign subscription with a default pool size", () => {
    const parsed = configSchema.parse({
      ...valid,
      subscriptions: [{ id: "s1", targetId: "c1",
                        label: "Alpha Campaign", rank: 0 }],
    });
    expect(parsed.subscriptions[0]?.poolSize).toBe(3);
  });


  test("rejects a pool size outside 1-10", () => {
    const bad = {
      ...valid,
      subscriptions: [{ id: "s1", targetId: "c1",
                        label: "x", rank: 0, poolSize: 99 }],
    };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });


  test("rejects a subscription that still carries a kind", () => {
    const bad = {
      ...valid,
      subscriptions: [{ id: "s1", kind: "game", targetId: "g1",
                        label: "Once Human", rank: 0 }],
    };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  test("a subscription may record the followed game that added it", () => {
    const parsed = configSchema.parse({
      ...valid,
      subscriptions: [{ id: "s1", targetId: "c1", label: "a", rank: 0, viaGame: "512953" }],
    });
    expect(parsed.subscriptions[0]?.viaGame).toBe("512953");
  });

  test("followed games default to none, and fill in pool size and skipped", () => {
    const { followedGames: _omitted, ...older } = valid;
    expect(configSchema.parse(older).followedGames).toEqual([]);
    const parsed = configSchema.parse({
      ...valid,
      followedGames: [{ id: "512953", name: "ELDEN RING", slug: "elden-ring", boxArtUrl: null }],
    });
    expect(parsed.followedGames[0]).toEqual({
      id: "512953", name: "ELDEN RING", slug: "elden-ring", boxArtUrl: null,
      poolSize: 3, skipped: [],
    });
  });

  test("rejects the same game followed twice", () => {
    const game = { id: "512953", name: "ELDEN RING", slug: "elden-ring", boxArtUrl: null };
    expect(configSchema.safeParse({ ...valid, followedGames: [game, game] }).success).toBe(false);
  });

  test("rejects duplicate subscription ids", () => {
    // Ownership is keyed by id; two subscriptions sharing one would make
    // "which streamers does this own" unanswerable.
    const bad = {
      ...valid,
      subscriptions: [
        { id: "s1", targetId: "c1", label: "a", rank: 0 },
        { id: "s1", targetId: "c2", label: "b", rank: 1 },
      ],
    };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  test("a streamer may record the subscription that added it", () => {
    const parsed = configSchema.parse({
      ...valid,
      streamers: [{ username: "alpha", enabled: true, settings: {},
                    ownedBy: "s1" }],
    });
    expect(parsed.streamers[0]?.ownedBy).toBe("s1");
  });

  test("a hand-added streamer has no owner", () => {
    const parsed = configSchema.parse(valid);
    expect(parsed.streamers[0]?.ownedBy).toBeUndefined();
  });

  test("rejects duplicate streamers", () => {
    const bad = {
      ...valid,
      streamers: [
        { username: "alpha", enabled: true, settings: {} },
        { username: "alpha", enabled: false, settings: {} },
      ],
    };
    expect(configSchema.safeParse(bad).success).toBe(false);
  });

  test("accepts points_limit as false or a positive integer, rejects negatives", () => {
    const mk = (v: unknown) => ({
      ...valid,
      streamers: [{ username: "alpha", enabled: true, settings: { pointsLimit: v } }],
    });
    expect(configSchema.safeParse(mk(false)).success).toBe(true);
    expect(configSchema.safeParse(mk(50000)).success).toBe(true);
    expect(configSchema.safeParse(mk(-1)).success).toBe(false);
  });

  test("accepts only real ChatPresence values", () => {
    const mk = (v: string) => ({
      ...valid,
      streamers: [{ username: "alpha", enabled: true, settings: { chat: v } }],
    });
    expect(configSchema.safeParse(mk("NEVER")).success).toBe(true);
    expect(configSchema.safeParse(mk("SOMETIMES")).success).toBe(false);
  });

  test("accepts a full bet block", () => {
    const mk = (bet: unknown) => ({
      ...valid,
      streamers: [{ username: "alpha", enabled: true, settings: { bet } }],
    });
    expect(configSchema.safeParse(mk({
      strategy: "SMART", percentage: 5, percentageGap: 20, maxPoints: 50000,
      minimumPoints: 0, stealthMode: false, delay: 6, delayMode: "FROM_END",
      filterCondition: { by: "total_users", where: "LTE", value: 800 },
    })).success).toBe(true);
    expect(configSchema.safeParse(mk({ strategy: "NOPE" })).success).toBe(false);
    expect(configSchema.safeParse(mk({ percentage: -1 })).success).toBe(false);
    expect(configSchema.safeParse(mk({ evil: 1 })).success).toBe(false);
    expect(configSchema.safeParse(mk({
      filterCondition: { by: "decision_users", where: "LTE", value: 1 },
    })).success).toBe(false);
  });

  test("accepts miner-wide options and rejects unknown priorities", () => {
    const mk = (miner: unknown) => ({ ...valid, miner });
    expect(configSchema.safeParse(mk({
      priority: ["STREAK", "DROPS", "ORDER"],
      claimDropsStartup: true,
      gql: { attempts: 3, attemptIntervalSeconds: 1 },
      weeklyRewards: { maxConcurrent: 2, maxClipWatchSeconds: 30,
                       maxVodWatchSeconds: 480, intervalSeconds: 20,
                       maxFailuresPerStreamer: 1, failureCooldownSeconds: 3600 },
    })).success).toBe(true);
    expect(configSchema.safeParse(mk({ weeklyRewards: false })).success).toBe(true);
    expect(configSchema.safeParse(mk({ priority: ["NOPE"] })).success).toBe(false);
    expect(configSchema.safeParse(mk({ evil: 1 })).success).toBe(false);
  });

  test("accepts simulateHlsPlayback as false or a refresh window", () => {
    const mk = (v: unknown) => ({
      ...valid,
      streamers: [{ username: "alpha", enabled: true, settings: { simulateHlsPlayback: v } }],
    });
    expect(configSchema.safeParse(mk(false)).success).toBe(true);
    expect(configSchema.safeParse(mk({ refreshBefore: 120 })).success).toBe(true);
    expect(configSchema.safeParse(mk({ refreshBefore: 0 })).success).toBe(false);
    expect(configSchema.safeParse(mk(true)).success).toBe(false);
  });
});

describe("store", () => {
  test("returns defaults when the file does not exist", () => {
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG);
  });

  test("round-trips a saved config", () => {
    saveConfig(path, valid as AppConfig);
    expect(loadConfig(path)).toEqual(valid);
  });

  test("campaign subscriptions saved with a kind still load, without it", () => {
    // Every subscription written before followed games carries
    // kind: "campaign"; refusing those would refuse every existing config.
    writeFileSync(path, JSON.stringify({
      ...valid,
      subscriptions: [{ id: "s1", kind: "campaign", targetId: "c1", label: "a", rank: 0 }],
    }));
    const loaded = loadConfig(path);
    expect(loaded.subscriptions).toEqual([
      { id: "s1", targetId: "c1", label: "a", rank: 0, poolSize: 3 },
    ]);
  });

  test("a config saved before subscriptions existed loads with an empty list", () => {
    // Every config already on disk predates the field, so the default is
    // what makes them loadable at all.
    const { subscriptions: _omitted, ...older } = valid;
    writeFileSync(path, JSON.stringify(older));
    expect(loadConfig(path).subscriptions).toEqual([]);
  });

  test("writes snake_case keys that Python accepts", () => {
    saveConfig(path, valid as AppConfig);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.defaults).toEqual({ make_predictions: false });
    expect(raw.followersOrder).toBe("ASC");
  });

  test("refuses to save an invalid config", () => {
    expect(() => saveConfig(path, { ...valid, version: 2 } as never)).toThrow();
  });

  test("throws a clear error on a corrupt file rather than returning defaults", () => {
    writeFileSync(path, "{not json");
    expect(() => loadConfig(path)).toThrow(/config.json/);
  });

  test("leaves no temp files behind after a save", () => {
    saveConfig(path, valid as AppConfig);
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });
});

describe("nested snake_case mapping", () => {
  const camel = {
    makePredictions: true,
    simulateHlsPlayback: { refreshBefore: 120 },
    bet: {
      strategy: "SMART", percentageGap: 20, maxPoints: 50000,
      minimumPoints: 0, stealthMode: false, delayMode: "FROM_END",
      filterCondition: { by: "total_users", where: "LTE", value: 800 },
    },
  };
  const snake = {
    make_predictions: true,
    simulate_hls_playback: { refresh_before: 120 },
    bet: {
      strategy: "SMART", percentage_gap: 20, max_points: 50000,
      minimum_points: 0, stealth_mode: false, delay_mode: "FROM_END",
      filter_condition: { by: "total_users", where: "LTE", value: 800 },
    },
  };

  test("renames keys inside bet and filter_condition", () => {
    expect(settingsToPython(camel)).toEqual(snake);
  });

  test("round-trips back to camelCase", () => {
    expect(settingsFromPython(snake)).toEqual(camel);
  });

  test("leaves a false simulateHlsPlayback as a bare false", () => {
    expect(settingsToPython({ simulateHlsPlayback: false }))
      .toEqual({ simulate_hls_playback: false });
    expect(settingsFromPython({ simulate_hls_playback: false }))
      .toEqual({ simulateHlsPlayback: false });
  });
});
