import type { EventEmitter } from "node:events";
import type { StreamsFrame } from "../../state/service.js";
import { NOTIFY_KIND } from "../catalogue.js";
import type { Notifier } from "../notifier.js";

/**
 * How recently a stream must have started to be announced as going live.
 * A backend back from downtime finds streams that began hours ago as new
 * rows; announcing those would be old news.
 */
export const FRESH_STREAM_MS = 30 * 60_000;

const link = (login: string) => `/?open=dashboard&streamer=${encodeURIComponent(login)}`;

export function watchStreams(deps: {
  notifier: Pick<Notifier, "publish">;
  stateService: Pick<EventEmitter, "on">;
}): void {
  deps.stateService.on("streams", (frame: StreamsFrame) => {
    for (const s of frame.started) {
      if (frame.at - s.startedAt > FRESH_STREAM_MS) continue;
      deps.notifier.publish({
        kind: NOTIFY_KIND.STREAMER_ONLINE, title: `${s.name} is live`, body: "Went live.",
        streamer: { login: s.login, name: s.name }, link: link(s.login),
      });
    }
    for (const s of frame.ended) {
      deps.notifier.publish({
        kind: NOTIFY_KIND.STREAMER_OFFLINE, title: `${s.name} went offline`, body: "The stream ended.",
        streamer: { login: s.login, name: s.name }, link: link(s.login),
      });
    }
  });
}
