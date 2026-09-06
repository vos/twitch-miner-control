const MB = 1024 * 1024;
const GB = 1024 * MB;

/**
 * Renders a process's resident memory for the header readout.
 *
 * Megabytes are whole numbers and gigabytes carry exactly one decimal,
 * so the string's width is stable as the value drifts. This sits beside
 * a uptime that re-renders every second and a badge to its left: a
 * readout that grew or shrank a character on the tick would shift them
 * (the same reasoning that pads formatUptime).
 *
 * Sub-megabyte values floor to "0 MB" rather than introducing a KB unit
 * that would appear only in a process's first moments.
 */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes);
  if (value >= GB) return `${(value / GB).toFixed(1)} GB`;
  return `${Math.floor(value / MB)} MB`;
}
