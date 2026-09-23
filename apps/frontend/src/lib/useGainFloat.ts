import { useState } from "react";

export interface GainFloatState {
  amount: number;
  /** New for every gain, so a gain arriving mid-float restarts it. */
  id: number;
}

/**
 * The gain to float over a balance, and a way to clear it once shown.
 *
 * Only an animated increase floats. A decrease is spending, which is not
 * worth celebrating, and a snapped change is one the user did not watch
 * happen.
 */
export function useGainFloat(
  value: number | null,
  animate: boolean,
): [GainFloatState | null, () => void] {
  const [float, setFloat] = useState<GainFloatState | null>(null);
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    if (animate && prev !== null && value !== null && value > prev) {
      setFloat({ amount: value - prev, id: (float?.id ?? 0) + 1 });
    }
  }
  return [float, () => setFloat(null)];
}
