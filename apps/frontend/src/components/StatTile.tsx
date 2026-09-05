import classes from "./StatTile.module.css";

export function StatTile({ label, value, hint, accent = "purple", testId }: {
  label: string;
  value: string;
  /**
   * A caveat about the number itself, rendered inside the value element so
   * it travels with it -- a qualifier on the figure, not a second label.
   */
  hint?: string;
  accent?: "purple" | "success" | "live";
  testId?: string;
}) {
  return (
    <div className={`${classes.tile} ${classes[accent]}`}>
      <div className={classes.label}>{label}</div>
      <div className={classes.value} data-testid={testId}>
        {value}
        {hint && <span className={classes.hint}>{hint}</span>}
      </div>
    </div>
  );
}
