/**
 * Reads the card's activity line out of the miner's own log message.
 *
 * The miner logs a point gain as, from `PubSub.py`:
 *
 *     +50 → Streamer(username=forsen, channel_id=1, channel_points=12.3k) - Reason: CLAIM.
 *
 * because our `LoggerSettings` leaves `less` at its default of False (see
 * `python/run.py`), so the interpolated Streamer renders through its
 * `__repr__` rather than the tidy `forsen (12.3k points)` form. Rendered
 * raw on a card that truncates at a couple of hundred pixels, that reads
 * "+50 → Streamer(username=forse…" -- worse than the bare event label,
 * which at least says what happened.
 *
 * So the exact parts are lifted out and the object noise is dropped. Two
 * rules hold here:
 *
 *  - The points earned is an integer the miner was given by PubSub, so it
 *    is safe to show. The *balance* in the same line went through
 *    millify() and is lossy ("12.3k"), so it is never read -- the card's
 *    own balance comes from the state pipeline.
 *  - Anything that does not match degrades to the event label alone. The
 *    doorbell bounds a message's shape but not its wording, and the miner
 *    is vendored code that can reformat its logs without warning; a card
 *    must lose the amount in that case, never the line.
 */

/**
 * `+{earned} → {streamer} - Reason: {code}.`
 *
 * Deliberately NOT anchored to the start of the string. The formatter
 * prepends an emoji to any record carrying one, and the gain line carries
 * `:rocket:` -- so what the doorbell actually sends is
 *
 *     🚀  +50 → Streamer(username=forsen, ...) - Reason: CLAIM.
 *
 * The emoji is a printable glyph, so the doorbell's control-character
 * scrub leaves it in place. An anchored `^\+` matched nothing in
 * production while every hand-written test fixture still passed, which is
 * exactly how a parser of display text fails quietly.
 *
 * The arrow is U+2192, not "->": the miner emits the real glyph. The
 * ASCII form is accepted too -- upstream rewrites the arrow to "-->" when
 * emoji are disabled (Windows), and it is what the backend fixtures use.
 *
 * `earned` is bounded to keep a pathological line from rendering as a
 * screenful of digits; the miner's real gains are two or three figures.
 */
const GAIN = /\+(\d{1,9})\s*(?:→|-->|->)/;

/** `- Reason: CLAIM.` -- the trailing period is the miner's, not ours. */
const REASON = /-\s*Reason:\s*([A-Z][A-Z0-9_]{0,31})\.?\s*$/;

export interface ParsedActivity {
  /** Points earned, when the line carried an exact figure. */
  earned: number | null;
  /** Short lower-case label: "claim", "watch", "streamer online". */
  label: string;
}

/**
 * Turns GAIN_FOR_CLAIM into "claim".
 *
 * The card wants a short label; the events feed already renders the
 * miner's full line, so repeating it here would just truncate badly.
 */
export function activityLabel(type: string): string {
  return type.toLowerCase().replace(/^gain_for_/, "").replace(/_/g, " ");
}

/**
 * The label always comes from the event *type*, never the message's
 * reason code: the type is validated against a bounded pattern at the
 * doorbell route, while the message is free text. They agree in practice
 * -- the miner builds the type as `GAIN_FOR_{reason_code}` -- so the
 * reason is used only to confirm the line is the gain it looks like,
 * which keeps a coincidental "+5 → ..." in some other event's wording
 * from being reported as points earned.
 */
export function parseActivity(
  type: string,
  message: string | null | undefined,
): ParsedActivity {
  const label = activityLabel(type);
  if (!message) return { earned: null, label };

  const gain = GAIN.exec(message);
  const reason = REASON.exec(message);
  if (gain === null || reason === null) return { earned: null, label };

  // The type is the authority on what happened; a message whose reason
  // disagrees with it is a line this parser does not understand.
  if (`GAIN_FOR_${reason[1]}` !== type.toUpperCase()) return { earned: null, label };

  const earned = Number(gain[1]);
  // A gain of zero is not a gain -- rendering "+0" would claim the miner
  // earned something when the line says it did not.
  return { earned: Number.isSafeInteger(earned) && earned > 0 ? earned : null, label };
}
