import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { configSchema } from "./schema.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./store.js";

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfg-"));
  path = join(dir, "config.json");
});

const valid = {
  version: 1,
  username: "alex",
  followers: true,
  followersOrder: "ASC",
  defaults: { makePredictions: false },
  streamers: [{ username: "alpha", enabled: true, settings: {} }],
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
});

describe("store", () => {
  test("returns defaults when the file does not exist", () => {
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG);
  });

  test("round-trips a saved config", () => {
    saveConfig(path, valid);
    expect(loadConfig(path)).toEqual(valid);
  });

  test("writes snake_case keys that Python accepts", () => {
    saveConfig(path, valid);
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
    saveConfig(path, valid);
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });
});
