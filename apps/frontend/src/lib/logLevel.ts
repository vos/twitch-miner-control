export type LogLevel = "error" | "warn" | "gain" | "info" | "debug";

/**
 * Classifies a miner log line for colouring.
 *
 * Anchors on the delimited level field (" - LEVEL - ") rather than
 * searching the whole line, so a message that merely contains the word
 * -- a channel name, a URL, a caught exception's text -- is not painted
 * red. The miner writes gains as "+50 -> streamer".
 */
export function levelOf(line: string): LogLevel {
  const level = / - (ERROR|CRITICAL|WARNING|WARN|INFO|DEBUG) - /.exec(line)?.[1];
  if (level === "ERROR" || level === "CRITICAL") return "error";
  if (level === "WARNING" || level === "WARN") return "warn";
  if (/\+\d+\s*->/.test(line)) return "gain";
  // DEBUG is the bulk of a real log (31k of 31k lines in a quiet run);
  // it recedes rather than competing with the lines that matter.
  if (level === "DEBUG") return "debug";
  return "info";
}
