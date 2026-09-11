import { Skeleton } from "@mantine/core";
import classes from "./StatTile.module.css";

export function StatTile({ label, value, hint, accent = "purple", testId, loading = false }: {
  label: string;
  value: string;
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
        {loading
          // Sized to the figure it replaces, so the tile does not resize
          // when the real number lands.
          ? <Skeleton height={20} width={82} radius="sm" data-testid={testId && `${testId}-loading`} />
          : value}
        {!loading && hint && <span className={classes.hint}>{hint}</span>}
      </div>
    </div>
  );
}
