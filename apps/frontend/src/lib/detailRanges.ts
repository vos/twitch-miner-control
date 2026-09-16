/**
 * The detail dialog's time windows.
 *
 * "all" sends from=0 rather than a computed floor: point history prunes
 * at 90 days by default, so only the server knows how far back anything
 * actually survives. It answers with what it kept and reports the oldest
 * sample as `retentionFloor`, which is what the chart labels itself by.
 */
export type RangeKey = "24h" | "7d" | "30d" | "all";

export const RANGE_KEYS: readonly RangeKey[] = ["24h", "7d", "30d", "all"];

export const RANGE_LABELS: Record<RangeKey, string> = {
  "24h": "24h",
  "7d": "7 days",
  "30d": "30 days",
  all: "All",
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const SPANS: Record<Exclude<RangeKey, "all">, number> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
};

export function rangeWindow(key: RangeKey, now: number): { from: number; to: number } {
  if (key === "all") return { from: 0, to: now };
  return { from: now - SPANS[key], to: now };
}
