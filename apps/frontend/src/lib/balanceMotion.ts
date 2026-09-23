import { useReducedMotion } from "@mantine/hooks";
import { useState } from "react";
import { useLiveState, type StateSnapshot } from "../api/useLiveState.js";

/** What about a live frame decides whether its changes may animate. */
export interface FrameMotion {
  /** Built from SQLite alone, with Twitch's figures still to come. */
  pending: boolean;
  /** The tab was visible when the frame arrived. */
  visible: boolean;
}

/**
 * Whether the change from one frame to the next is one the user watched
 * happen, and so may animate.
 *
 * Anything else snaps. The first frame is the page loading. A pending
 * frame's figures are about to be corrected by Twitch's, and that jump is
 * a correction rather than a gain. A frame that arrived while the tab was
 * hidden carries changes nobody saw, and replaying them on return would
 * show old news as new.
 */
export function canAnimate(
  prev: FrameMotion | null,
  next: FrameMotion,
  reducedMotion: boolean,
): boolean {
  if (reducedMotion || prev === null) return false;
  return !prev.pending && prev.visible && !next.pending && next.visible;
}

interface Seen {
  snapshot: StateSnapshot | null;
  frame: FrameMotion | null;
  animate: boolean;
}

/**
 * `canAnimate` applied to each new snapshot as it arrives.
 *
 * Decided once per snapshot object, not per render: a re-render that
 * carries the same snapshot keeps the answer that snapshot got. Visibility
 * is read at arrival, which is the moment that decides whether the change
 * was seen.
 */
export function useFrameMotion(snapshot: StateSnapshot | null, reducedMotion: boolean): boolean {
  const [seen, setSeen] = useState<Seen>({ snapshot: null, frame: null, animate: false });
  if (snapshot === seen.snapshot) return seen.animate;

  const frame = snapshot === null ? null : {
    pending: snapshot.pending === true,
    visible: document.visibilityState === "visible",
  };
  const next = {
    snapshot, frame,
    animate: frame !== null && canAnimate(seen.frame, frame, reducedMotion),
  };
  setSeen(next);
  return next.animate;
}

/** Whether the balances in the current live snapshot may animate. */
export function useBalanceMotion(): boolean {
  const { snapshot } = useLiveState();
  return useFrameMotion(snapshot, useReducedMotion());
}
