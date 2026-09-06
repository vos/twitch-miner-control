/** Days of point history kept when HISTORY_RETENTION_DAYS is unset. */
export const RETENTION_DAYS = 90;

/**
 * Resolves HISTORY_RETENTION_DAYS to a day count, 0 meaning "never prune".
 *
 * `point_snapshots` is the only table that grows per tick, so it is the
 * only one pruned. The session tables backing the all-time mining figure
 * are tiny -- a few rows per streamer per day -- and dropping rows from
 * them would corrupt the very number they exist to answer.
 *
 * Zero is a legitimate setting and is honoured, so this cannot be a
 * falsy check. Values under a day clamp to one: the 24h gain figures and
 * the sparkline read the same table, and pruning inside that window
 * would erode them. Nonsense falls back to the default rather than
 * yielding NaN, which would make the cutoff NaN and silently delete
 * nothing while looking configured.
 */
export function resolveRetentionDays(value: string | undefined): number {
  // `Number("")` and `Number("   ")` are 0, not NaN, so a bare
  // `HISTORY_RETENTION_DAYS=` in .env would otherwise read as "never
  // prune" rather than as an unset variable.
  if (value === undefined || value.trim() === "") return RETENTION_DAYS;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return RETENTION_DAYS;
  if (days === 0) return 0;
  return Math.max(1, Math.floor(days));
}
