/** One stream session as the detail endpoint reports it. */
export interface DetailSession {
  streamId: string;
  start: number;
  end: number | null;
  /** Milliseconds of this stream the miner was actually up for. */
  mined: number;
  /** Points earned, or null when the session has no anchor balance. */
  earned: number | null;
}

export interface StreamRow extends DetailSession {
  /** The session is still open. */
  live: boolean;
  length: number;
  /** Mined fraction, 0-1, or null when the stream has no measurable length. */
  coverage: number | null;
}

/**
 * Prepares stream sessions for the detail table.
 *
 * Order is left alone: the endpoint already returns newest first, and
 * re-sorting here would silently disagree with it.
 *
 * `coverage` is clamped to 1. The two figures come from different tables
 * -- stream sessions from Twitch's timestamps, mined time from the
 * miner's own spans -- so a little skew between them is normal, and a
 * row claiming 140% coverage would read as a bug in the reader rather
 * than the rounding it is.
 */
export function sessionRows(sessions: DetailSession[], now: number): StreamRow[] {
  return sessions.map((s) => {
    const live = s.end === null;
    const length = Math.max(0, (s.end ?? now) - s.start);
    return {
      ...s,
      live,
      length,
      coverage: length === 0 ? null : Math.min(1, s.mined / length),
    };
  });
}
