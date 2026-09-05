import classes from "./StatTile.module.css";

export function StatTile({ label, value, accent = "purple", testId }: {
  label: string;
  value: string;
  accent?: "purple" | "success" | "live";
  testId?: string;
}) {
  return (
    <div className={`${classes.tile} ${classes[accent]}`}>
      <div className={classes.label}>{label}</div>
      <div className={classes.value} data-testid={testId}>{value}</div>
    </div>
  );
}
