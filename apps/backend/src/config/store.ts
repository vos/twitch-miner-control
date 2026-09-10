import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import {
  type AppConfig, configSchema, minerFromPython, minerToPython,
  settingsFromPython, settingsToPython,
} from "./schema.js";

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  username: "",
  followers: false,
  followersOrder: "ASC",
  defaults: {},
  miner: {},
  streamers: [],
};

export function loadConfig(path: string): AppConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`config.json is not valid JSON: ${String(cause)}`);
  }
  const r = raw as Record<string, unknown>;
  const rawStreamers = Array.isArray(r.streamers) ? r.streamers : [];
  const camel = {
    ...r,
    defaults: settingsFromPython((r.defaults as Record<string, unknown>) ?? {}),
    miner: minerFromPython((r.miner as Record<string, unknown>) ?? {}),
    streamers: rawStreamers.map((s: Record<string, unknown>) => ({
      ...s,
      settings: settingsFromPython((s.settings as Record<string, unknown>) ?? {}),
    })),
  };
  const parsed = configSchema.safeParse(camel);
  if (!parsed.success) {
    throw new Error(`config.json failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function saveConfig(path: string, config: AppConfig): void {
  const valid = configSchema.parse(config);
  const onDisk = {
    ...valid,
    defaults: settingsToPython(valid.defaults),
    miner: minerToPython(valid.miner),
    streamers: valid.streamers.map((s) => ({
      ...s,
      settings: settingsToPython(s.settings),
    })),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (cause) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw cause;
  }
}
