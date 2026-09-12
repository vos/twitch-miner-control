import { normaliseUsername } from "./roster.js";

/**
 * How long a fetched drop is trusted.
 *
 * Ten minutes, deliberately far off the 60s state poll. Drops are the
 * one signal on the card that costs calls Twitch is not already being
 * asked for: one global inventory plus one per eligible live channel,
 * every time. Upstream itself syncs campaigns on a 30-60 minute
 * background timer, which is the scale this belongs on.
 *
 * Ten minutes is invisible in the UI because drop progress moves in
 * 30/60/120-minute steps -- a 120-minute drop advances about 8% between
 * refreshes, so the bar is never meaningfully stale.
 */
export const DROPS_TTL_MS = 600_000;

/** The next drop a channel has still to earn. */
export interface DropProgress {
  name: string;
  /** Minutes watched toward it, clamped to `required` by the helper. */
  minutes: number;
  required: number;
  /** Minutes met and an instance minted -- it is sitting there to collect. */
  claimable: boolean;
  /**
   * What the drop awards, deduped by the helper. Empty when the miner
   * build's parser predates the field.
   */
  benefits: string[];
  /** Campaign deadline in epoch ms, or null when not reported. */
  endsAt: number | null;
}

export interface DropsCacheDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
  /**
   * Whether the miner claims drops for this login -- see dropsEligible.
   * A channel that fails this is never asked about: with the setting off
   * the miner is not syncing its campaigns, so there is nothing to read.
   */
  eligible: (login: string) => boolean;
  now?: () => number;
}

/** One channel to consider, as the state snapshot knows it. */
export interface DropsTarget {
  username: string;
  /** The available-drops query is keyed by this, not by login. */
  channelId: string | null;
}

/**
 * The next unclaimed drop per channel, on its own slow clock.
 *
 * Held in memory only. Drop progress is a live figure whose whole value
 * is being current; reloaded from disk after a restart it would describe
 * whatever was true when the process last ran.
 *
 * Never rejects. The dashboard's job is balances, and a drop badge must
 * not be able to fail the refresh it rides along with.
 */
export class DropsCache {
  private readonly cached = new Map<string, DropProgress | null>();
  private fetchedAt = 0;

  constructor(private readonly deps: DropsCacheDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async resolve(targets: DropsTarget[]): Promise<Map<string, DropProgress>> {
    // Eligibility is re-read every pass rather than cached: turning
    // claim_drops off must clear the badge, not leave the last value
    // frozen on the card.
    const wanted = new Map<string, string>();
    for (const t of targets) {
      const login = normaliseUsername(t.username);
      if (t.channelId === null || !this.deps.eligible(login)) continue;
      wanted.set(login, t.channelId);
    }

    const at = this.now();
    if (wanted.size > 0 && at - this.fetchedAt > DROPS_TTL_MS) {
      try {
        const data = await this.deps.client.request<{
          drops: Record<string, DropProgress | null>;
        }>("drops", { streamers: Object.fromEntries(wanted) });
        // Replaced wholesale rather than merged: a campaign that has
        // ended stops being reported, and merging would keep its bar on
        // the card for a drop that can no longer be earned.
        this.cached.clear();
        for (const login of wanted.keys()) {
          this.cached.set(login, data.drops?.[login] ?? null);
        }
        this.fetchedAt = at;
      } catch {
        // Swallowed deliberately -- see the class docstring. The previous
        // values stand and the next pass tries again. fetchedAt is left
        // alone so a failure does not buy a full TTL of silence.
      }
    }

    const out = new Map<string, DropProgress>();
    for (const login of wanted.keys()) {
      const drop = this.cached.get(login);
      if (drop) out.set(login, drop);
    }
    return out;
  }
}
