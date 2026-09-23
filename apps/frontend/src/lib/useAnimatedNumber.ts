import { useEffect, useRef, useState } from "react";

/** How long a balance takes to roll to its new value. */
export const ROLL_MS = 600;

/** Fast start, gentle landing: most of the distance is covered early. */
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

/**
 * `value`, eased toward over `duration` whenever it changes with `animate`
 * set; otherwise `value` itself, at once.
 *
 * A change arriving mid-roll continues from the figure currently shown
 * rather than jumping back to where the roll began.
 */
export function useAnimatedNumber(
  value: number | null,
  animate: boolean,
  duration = ROLL_MS,
): number | null {
  const [shown, setShown] = useState(value);
  // What is on screen right now, for a roll that starts mid-roll.
  const shownRef = useRef(value);

  useEffect(() => {
    const from = shownRef.current;
    if (!animate || from === null || value === null || from === value) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    let start: number | null = null;
    let frame = requestAnimationFrame(function step(now) {
      start ??= now;
      const t = Math.min(1, (now - start) / duration);
      const next = t === 1 ? value : Math.round(from + (value - from) * easeOut(t));
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, animate, duration]);

  // A snapped change is returned directly: waiting for the effect would
  // paint the old figure for a frame.
  return animate ? shown : value;
}
