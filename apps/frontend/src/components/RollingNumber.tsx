import { VisuallyHidden } from "@mantine/core";
import { useAnimatedNumber } from "../lib/useAnimatedNumber.js";

const nf = new Intl.NumberFormat("en-US");

/**
 * A formatted count that rolls to a new value when `animate` is set.
 *
 * At rest it renders the bare figure. Only while it moves does it split
 * in two: the moving digits are aria-hidden, and a visually hidden copy of
 * the final figure is what assistive tech reads, so nobody hears a dozen
 * intermediate balances.
 */
export function RollingNumber({ value, animate }: {
  value: number | null;
  animate: boolean;
}) {
  const shown = useAnimatedNumber(value, animate);
  if (value === null) return <>—</>;
  if (shown === null || shown === value) return <>{nf.format(value)}</>;
  return (
    <>
      <span aria-hidden>{nf.format(shown)}</span>
      <VisuallyHidden>{nf.format(value)}</VisuallyHidden>
    </>
  );
}
