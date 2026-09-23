import type { Streamers } from "../db/streamers.js";
import { clip, intersect, total, type Span } from "../state/spans.js";
import type { RollupDeps } from "./rollup.js";

export interface InsightsDeps extends RollupDeps {
  /** For first sightings and names; read defensively, as the server does. */
  streamers?: Streamers;
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
