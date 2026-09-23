import { Skeleton } from "@mantine/core";
import type { ReactNode } from "react";
import classes from "./StatTile.module.css";

export function StatTile(
  { label, value, hint, icon, accent = "purple", testId, loading = false }: {
  label: string;
  value: ReactNode;
  /**
   * A glyph marking what the figure counts, rendered before it.
   *
   * The row mixes units -- points and channels -- and the icon is what
   * makes that legible at a glance rather than only in the label above.
   * Caller-supplied so this component stays agnostic about which units
   * exist; it must be aria-hidden, since the label already names the
   * figure for assistive tech.
   */
  icon?: ReactNode;
  /**
   * A caveat about the number itself, rendered inside the value element so
   * it travels with it -- a qualifier on the figure, not a second label.
   */
  hint?: string;
  accent?: "purple" | "success" | "live";
  testId?: string;
  /**
   * Stands a placeholder in for the figure while it is still unknown.
   *
   * The label stays: it is fixed text that says what the tile will hold,
   * so showing it early tells the user the shape of the page rather than
   * making them guess. Only the number waits.
   */
  loading?: boolean;
}) {
  return (
    <div className={`${classes.tile} ${classes[accent]}`}>
      <div className={classes.label}>{label}</div>
      <div className={classes.value} data-testid={loading ? undefined : testId}>
        {/* The icon renders in both states: it is known up front, so
            only the number waits. Keeping it out of the skeleton also
            stops the tile shifting sideways when the figure lands. */}
        <div className={classes.figure}>
          {icon}
          {loading
            // Sized to the figure it replaces, so the tile does not
            // resize when the real number arrives.
            ? <Skeleton height={20} width={82} radius="sm" data-testid={testId && `${testId}-loading`} />
            : value}
        </div>
        {!loading && hint && <span className={classes.hint}>{hint}</span>}
      </div>
    </div>
  );
}
