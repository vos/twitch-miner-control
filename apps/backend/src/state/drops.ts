import { normaliseUsername } from "./roster.js";

/**
 * How long a fetched drop is trusted.
 *
 * Ten minutes, deliberately far off the 60s state poll. Drops are the
 * one signal on the card that costs calls Twitch is not already being
 * asked for: one per eligible live channel, every time. Upstream itself
 * syncs campaigns on a 30-60 minute background timer, which is the scale
 * this belongs on.
 *
 * The minutes on a watched channel move between fetches, by observe().
 * This clock is what picks up everything progress events do not carry:
 * a drop turning claimable, and channels the miner is not watching.
 */
export const DROPS_TTL_MS = 600_000;

/** The next drop a channel has still to earn. */
export interface DropProgress {
  /** The id the miner's progress events name this drop by. */
  id: string;
  name: string;
  /** Minutes watched toward it, clamped to `required` by the helper. */
  minutes: number;
  required: number;
  /** Minutes met and an instance minted -- it is sitting there to collect. */
  claimable: boolean;
  /** What the drop awards, deduped by the helper. */
  benefits: string[];
  /** Campaign deadline in epoch ms, or null when not reported. */
  endsAt: number | null;
  /**
   * Whether the campaign's game account is connected. ALL mode earns an
   * unlinked campaign's drops, but the miner claims only on a linked account.
   */
  linked: boolean;
  /** Where to connect it, when Twitch says. */
  linkUrl: string | null;
}

/** A drop as the miner's progress event describes it. */
export type ObservedDrop = Omit<DropProgress, "claimable" | "linked" | "linkUrl">;

export interface DropsCacheDeps {
  client: { request<T>(op: string, params?: object): Promise<T> };
  /**
   * Whether the miner claims drops for this login -- see dropsEligible.
   * A channel that fails this is never asked about: with the setting off
   * the miner is not syncing its campaigns, so there is nothing to read.
   */
  eligible: (login: string) => boolean;
  /**
   * Whether the miner progresses this login's campaigns even with the
   * game account unlinked. The helper leaves unlinked campaigns off every
   * other card, since their bar would never move.
   */
  allowsUnlinked: (login: string) => boolean;
  now?: () => number;
}

/** One channel to consider, as the state snapshot knows it. */
export interface DropsTarget {
  username: string;
  /** The campaign progress query is keyed by this, not by login. */
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
  /**
   * The last answer per channel, each on its own clock. A channel with no
   * entry has never been asked about, which is not the same as a stored
   * null: going live or being switched on must not wait out another
   * channel's TTL before its badge can appear.
   */
  private readonly cached = new Map<
    string,
    { drop: DropProgress | null; fetchedAt: number }
  >();

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
    const due = [...wanted].filter(([login]) => {
      const entry = this.cached.get(login);
      return entry === undefined || at - entry.fetchedAt > DROPS_TTL_MS;
    });
    if (due.length > 0) {
      const logins = due.map(([login]) => login);
      try {
        const data = await this.deps.client.request<{
          drops: Record<string, DropProgress | null>;
        }>("drops", {
          streamers: Object.fromEntries(due),
          allowUnlinked: logins.filter(this.deps.allowsUnlinked),
        });
        // A null is stored rather than skipped: a campaign that has ended
        // stops being reported, and keeping the old entry would leave its
        // bar on the card for a drop that can no longer be earned.
        for (const login of logins) {
          this.cached.set(login, {
            drop: data.drops?.[login] ?? null,
            fetchedAt: at,
          });
        }
      } catch {
        // Swallowed deliberately -- see the class docstring. The previous
        // values stand and the next pass tries again. Their clocks are
        // left alone so a failure does not buy a full TTL of silence.
      }
    }

    const out = new Map<string, DropProgress>();
    for (const login of wanted.keys()) {
      const drop = this.cached.get(login)?.drop;
      if (drop) out.set(login, drop);
    }
    return out;
  }

  /**
   * Applies a progress event, returning what the card should now show.
   *
   * Null when there is nothing to show: a channel not claiming drops, or
   * one never asked about, where only the helper can say whether the
   * account is linked. The fetch clock is left alone, so the next read
   * still picks up what progress events do not carry.
   *
   * A different drop from the one held replaces it. The helper reports the
   * nearest drop on the channel; this is the one really moving.
   */
  observe(login: string, seen: ObservedDrop): DropProgress | null {
    const key = normaliseUsername(login);
    const entry = this.cached.get(key);
    if (entry === undefined || !this.deps.eligible(key)) return null;
    const held = entry.drop;
    const drop: DropProgress = held?.id === seen.id
      ? { ...held, minutes: seen.minutes, required: seen.required }
      : { ...seen, claimable: false, linked: held?.linked ?? true, linkUrl: held?.linkUrl ?? null };
    this.cached.set(key, { ...entry, drop });
    return drop;
  }

  /**
   * Forgets a drop the miner has tried to claim, so the next read asks what
   * comes after it. Every channel holding it goes: a campaign spans
   * channels, and the claim event names none.
   */
  forget(dropId: string): void {
    for (const [login, entry] of this.cached) {
      if (entry.drop?.id === dropId) this.cached.delete(login);
    }
  }
}
