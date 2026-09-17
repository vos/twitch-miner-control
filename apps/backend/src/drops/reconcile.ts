import type { AppConfig } from "../config/schema.js";
import { normaliseUsername } from "../state/roster.js";

type Streamer = AppConfig["streamers"][number];

/** One channel a subscription wants in the config. */
export interface DesiredEntry {
  username: string;
  /** The id of the subscription that resolved it. */
  ownedBy: string;
}

export interface Reconciliation {
  streamers: AppConfig["streamers"];
  /**
   * Whether the config actually differs.
   *
   * This is the restart verdict: the engine restarts the miner if and
   * only if this is true, so a pass that resolves the same channels as
   * the last one costs nothing at all -- which is the common case, since
   * resolution runs on a timer and most passes find the same channels
   * still live.
   */
  changed: boolean;
}

/**
 * Folds the subscriptions' desired channels into the streamer list.
 *
 * Pure by design -- no clock, no network, no I/O -- because this is the
 * function that decides whether the miner restarts, and that decision
 * has to be exhaustively testable. A restart costs the miner's
 * accumulated watch-session state, so a spurious `changed: true` is not
 * a cosmetic bug.
 *
 * Two invariants:
 *
 *  - Hand-added streamers are never added, removed or reordered. The
 *    user's roster is theirs; the engine owns only entries carrying an
 *    `ownedBy`.
 *  - A channel the user already added stays theirs. Their entry keeps
 *    its own settings and the subscription simply does not duplicate it,
 *    rather than the engine taking ownership of a row it did not create.
 */
export function reconcile(
  current: AppConfig["streamers"],
  desired: DesiredEntry[],
): Reconciliation {
  const manual = current.filter((s) => s.ownedBy === undefined);
  const manualLogins = new Set(manual.map((s) => normaliseUsername(s.username)));

  // Drop anything the user already owns, and dedupe within the desired
  // list itself -- two subscriptions can resolve the same channel, and
  // the first writer wins, which is the higher-ranked one because the
  // engine builds this list in rank order.
  const seen = new Set<string>();
  const wanted: DesiredEntry[] = [];
  for (const entry of desired) {
    const login = normaliseUsername(entry.username);
    if (manualLogins.has(login) || seen.has(login)) continue;
    seen.add(login);
    wanted.push(entry);
  }

  // Existing owned rows are reused rather than rebuilt, so a re-resolve
  // does not silently reset a channel's settings.
  const existing = new Map(
    current
      .filter((s) => s.ownedBy !== undefined)
      .map((s) => [normaliseUsername(s.username), s]),
  );

  const owned: Streamer[] = wanted.map((entry) => {
    const previous = existing.get(normaliseUsername(entry.username));
    if (previous !== undefined) return { ...previous, ownedBy: entry.ownedBy };
    // enabled: true is load-bearing -- build_streamers skips anything
    // else, so a channel added disabled would sit in the config unwatched.
    return {
      username: entry.username,
      enabled: true,
      settings: {},
      ownedBy: entry.ownedBy,
    } as Streamer;
  });

  const streamers = [...manual, ...owned];
  return { streamers, changed: differs(current, streamers) };
}

/**
 * Order-sensitive on purpose: order is what upstream's `priority_order`
 * consumes, so two lists with the same members in a different sequence
 * genuinely tell the miner to watch different channels first.
 */
function differs(
  a: AppConfig["streamers"],
  b: AppConfig["streamers"],
): boolean {
  if (a.length !== b.length) return true;
  return a.some((entry, i) => {
    const other = b[i];
    if (other === undefined) return true;
    return (
      normaliseUsername(entry.username) !== normaliseUsername(other.username)
      || entry.ownedBy !== other.ownedBy
    );
  });
}
