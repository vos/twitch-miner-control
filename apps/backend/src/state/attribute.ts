/**
 * Identifies which roster streamer a miner log line is about.
 *
 * The `events` table is global -- the doorbell forwards the miner's own
 * formatted message, in which the streamer's name is the only per-channel
 * detail that survives. This matches that message against the *known*
 * roster, which is a different operation from parsing the message: the
 * candidate set is closed, so a hit is an identification rather than an
 * interpretation. Balances inside the message stay untouched; they are
 * millified and lossy (see python/helpers/doorbell.py).
 *
 * An ambiguous message -- a raid line names two channels -- returns null.
 * Picking the first match would be a guess, and a wrong guess puts one
 * streamer's activity on another's card, which is worse than showing no
 * activity at all.
 */
export function attribute(message: string | null, roster: string[]): string | null {
  if (!message) return null;
  const lowered = message.toLowerCase();
  let found: string | null = null;
  for (const login of roster) {
    if (!matches(lowered, login.toLowerCase())) continue;
    // A second *distinct* streamer makes the line ambiguous. The same
    // login matching twice is not ambiguity -- the line is still about
    // one channel.
    if (found !== null && found !== login) return null;
    found = login;
  }
  return found;
}

/**
 * Whether `login` appears in `text` as a whole name.
 *
 * Twitch logins are `[a-zA-Z0-9_]`, so the boundary is any character
 * outside that set. `\b` alone would not do: it counts `_` as a word
 * character in the wrong direction, matching "alpha" inside "alpha_bot".
 */
function matches(text: string, login: string): boolean {
  const boundary = "[^a-z0-9_]";
  return new RegExp(`(^|${boundary})${escape(login)}($|${boundary})`).test(text);
}

/** Escapes regex metacharacters. Logins are constrained, but this is cheap. */
function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
