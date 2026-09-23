import type { Streamers } from "../db/streamers.js";
import { clip, intersect, total, type Span } from "../state/spans.js";
import type { RollupDeps } from "./rollup.js";

export interface InsightsDeps extends RollupDeps {
  /** For first sightings and names; read defensively, as the server does. */
  streamers?: Streamers;
}

/**
 * The time covered by any of the spans, with overlaps counted once.
 *
 * What "mined" means once channels are combined: the time the miner spent
 * mining. Adding each channel's mined time instead counts every tracked
 * channel that happened to be live while the miner was up -- with a large
 * roster, many times the miner's own uptime, though Twitch only credits
 * two channels at a time.
 */
export function mergeSpans(spans: ReadonlyArray<Span>): Array<{ start: number; end: number }> {
  const sorted = spans
    .map((s) => ({ start: s.start, end: s.end ?? s.start }))
    .sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

/**
 * Each channel's mined spans within `[fromTs, toTs]`, and how many of its
 * streams had any.
 *
 * Mined is the dashboard's three-clock rule: live, miner up, and on or
 * after our first sighting of the channel -- Twitch back-dates a stream
 * to its own start, which may be long before we were watching.
 */
export function minedByStreamer(
  deps: InsightsDeps,
  fromTs: number,
  toTs: number,
): Map<string, { spans: Span[]; streams: number }> {
  const miner = clip(deps.history.minerSpans(fromTs), fromTs, toTs);
  const out = new Map<string, { spans: Span[]; streams: number }>();
  for (const session of deps.history.allStreamerSpans(fromTs)) {
    const floor = Math.max(fromTs, deps.streamers?.firstSeen(session.streamer) ?? 0);
    const mined = intersect(clip([session], floor, toTs), miner);
    if (total(mined) === 0) continue;
    const entry = out.get(session.streamer) ?? { spans: [], streams: 0 };
    entry.spans.push(...mined);
    entry.streams += 1;
    out.set(session.streamer, entry);
  }
  return out;
}
