import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { useStreamEvent } from "../api/useLiveState.js";
import { appendPage, type LivePage } from "./appendPage.js";

/** Delay before trying a failed load again. */
export const RETRY_MS = 5000;

export interface UseLiveLogOptions<T> {
  /** The endpoint serving the whole buffer. */
  endpoint: string;
  /** The SSE event name frames arrive under. */
  event: string;
  /** How many items to keep on screen. */
  maxItems: number;
  /** Pulls the page shape out of whatever the endpoint returns. */
  toPage: (body: unknown) => LivePage<T>;
}

export interface LiveLog<T> {
  page: LivePage<T> | null;
  error: string | null;
  /** The raw body of the last successful load, for anything outside the page. */
  body: unknown;
}

/**
 * Loads a log and keeps it current from the event stream.
 *
 * Extracted from the miner Logs route unchanged so the app event log can
 * reuse it rather than carry a second copy: the load/subscribe/gap/retry
 * interplay here is where the bugs would be, and two versions of it would
 * drift. The contract it preserves:
 *
 *  - Frames that arrive while the initial load is in flight are queued
 *    and replayed on top of it, rather than being dropped or applied to
 *    a page that does not exist yet.
 *  - A frame that cannot be placed (items were missed) triggers a full
 *    reload, because nothing else can close the gap.
 *  - A failed load retries on a timer and surfaces the reason, rather
 *    than leaving a blank panel -- this is exactly where an operator
 *    looks to diagnose a failure, so it must not fail silently.
 */
export function useLiveLog<T>(options: UseLiveLogOptions<T>): LiveLog<T> {
  const { endpoint, event, maxItems, toPage } = options;
  const [page, setPage] = useState<LivePage<T> | null>(null);
  const [body, setBody] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to load the whole log again.
  const [reloads, setReloads] = useState(0);
  // What frames append to, kept in a ref so two frames in one tick each
  // build on the one before. Null while a load is in flight.
  const base = useRef<LivePage<T> | null>(null);
  // Frames that arrived while a load was in flight, applied on top of it.
  const early = useRef<Array<LivePage<T>>>([]);
  // Held in a ref so a caller passing an inline function does not
  // re-subscribe the stream on every render.
  const convert = useRef(toPage);
  convert.current = toPage;

  const show = (next: LivePage<T>) => {
    base.current = next;
    setPage(next);
  };

  useStreamEvent<unknown>(event, (raw) => {
    const frame = convert.current(raw);
    if (base.current === null) {
      early.current.push(frame);
      return;
    }
    const next = appendPage(base.current, frame, maxItems);
    if (next === null) setReloads((n) => n + 1);
    else if (next !== base.current) show(next);
  });

  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    base.current = null;
    early.current = [];

    const load = () =>
      api.get<unknown>(endpoint)
        .then((loaded) => {
          if (!alive) return;
          const first = convert.current(loaded);
          // The load already holds everything produced before it
          // answered, so these frames can only add to it -- a gap is not
          // possible here.
          const merged = early.current.reduce(
            (acc, frame) => appendPage(acc, frame, maxItems) ?? acc,
            first,
          );
          early.current = [];
          setBody(loaded);
          show(merged);
          // A success after a failed attempt must clear its banner --
          // otherwise a one-off hiccup leaves a permanent error even
          // though the log is flowing again.
          setError(null);
        })
        .catch((cause: unknown) => {
          if (!alive) return;
          setError(cause instanceof Error ? cause.message : String(cause));
          retry = setTimeout(load, RETRY_MS);
        });
    void load();
    return () => {
      alive = false;
      if (retry !== null) clearTimeout(retry);
    };
  }, [reloads, endpoint, maxItems]);

  return { page, error, body };
}
