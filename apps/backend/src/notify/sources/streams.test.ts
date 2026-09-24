import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { FRESH_STREAM_MS, watchStreams } from "./streams.js";

test("a fresh stream is published as online; a stale one is not", () => {
  const publish = vi.fn();
  const stateService = new EventEmitter();
  watchStreams({ notifier: { publish }, stateService });
  const at = 10 * FRESH_STREAM_MS;
  stateService.emit("streams", {
    at,
    started: [
      { login: "alpha", name: "Alpha", startedAt: at - 60_000 },
      { login: "beta", name: "Beta", startedAt: at - FRESH_STREAM_MS - 1 },
    ],
    ended: [{ login: "gamma", name: "Gamma" }],
  });
  expect(publish.mock.calls.map(([n]) => [n.kind, n.title, n.streamer.login, n.link])).toEqual([
    ["streamer.online", "Alpha is live", "alpha", "/?open=dashboard&streamer=alpha"],
    ["streamer.offline", "Gamma went offline", "gamma", "/?open=dashboard&streamer=gamma"],
  ]);
});
