import { useEffect } from "react";
import type { GainFloatState } from "../lib/useGainFloat.js";
import classes from "./GainFloat.module.css";

const nf = new Intl.NumberFormat("en-US");

/** How long a float takes to rise and fade; also when it is removed. */
export const FLOAT_MS = 1200;

/**
 * A `+N` that rises off a balance and fades.
 *
 * Keyed by the gain's id, so a second gain mid-float remounts it and the
 * animation starts over rather than finishing the first one's run.
 *
 * Removed on a timer rather than on `animationend`: under reduced motion
 * the float is `display: none`, which never fires that event.
 */
export function GainFloat({ float, onDone }: {
  float: GainFloatState | null;
  onDone: () => void;
}) {
  const id = float?.id ?? null;
  useEffect(() => {
    if (id === null) return;
    const timer = setTimeout(onDone, FLOAT_MS);
    return () => clearTimeout(timer);
    // onDone is a fresh closure every render; only a new gain restarts the timer.
  }, [id]);

  if (float === null) return null;
  return (
    <span
      key={float.id}
      className={classes.float}
      style={{ animationDuration: `${FLOAT_MS}ms` }}
      aria-hidden="true"
      data-testid="gain-float"
    >
      +{nf.format(float.amount)}
    </span>
  );
}
