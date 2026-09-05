/**
 * Resolves which channels the dashboard should show.
 *
 * The miner builds this same union internally -- it appends the follow list
 * to its own in-memory roster in TwitchChannelPointsMiner.run -- but never
 * writes it back to config.json and never reports it to the backend. A
 * backend reading only config.json therefore rendered the manually added
 * streamers while the miner happily mined the followed ones too, which is
 * exactly the mismatch this repairs. We repeat the fetch rather than share
 * it: the two can disagree for up to one refresh interval after a
 * follow/unfollow, the price of not threading a reporting channel through
 * vendored code.
 */

/** Mirrors the miner's utils/Utils.normalise_username. */
export function normaliseUsername(username: string): string {
  return username.toLowerCase().trim().replaceAll(" ", "");
}

export interface RosterDeps {
  /** Enabled streamer logins from config.json, in config order. */
  configured: () => string[];
  /** Whether the "mine my followed channels" setting is on. */
  followersEnabled: () => boolean;
  /** Fetches the follow list from Twitch. */
  fetchFollowers: () => Promise<string[]>;
  /** Reports a failed follower fetch. */
  onError?: (cause: unknown) => void;
}

/**
 * Config entries win and keep their order; followers are appended in
 * Twitch's order; a channel in both appears once. Without the dedupe the
 * common case -- a followed channel also added by hand -- would render
 * twice and be polled twice.
 *
 * A failed follower fetch degrades to the configured list rather than
 * propagating: an expired login or a Twitch blip should leave the dashboard
 * showing what it can, not blank it. StateService still surfaces the
 * underlying auth failure through its own error path.
 */
export async function resolveRoster(deps: RosterDeps): Promise<string[]> {
  const names = [...deps.configured()];
  if (deps.followersEnabled()) {
    try {
      names.push(...(await deps.fetchFollowers()));
    } catch (cause) {
      deps.onError?.(cause);
    }
  }
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = normaliseUsername(name);
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
