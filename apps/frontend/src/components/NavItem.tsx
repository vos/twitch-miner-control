import type { ReactNode } from "react";
import classes from "./NavItem.module.css";

/**
 * One sidebar row.
 *
 * A button rather than Mantine's NavLink: the active treatment is a
 * flush-left purple bar that NavLink's own structure cannot express, and
 * aria-current carries the state to assistive tech that cannot see it.
 */
export function NavItem({ icon, label, active, onClick, badge }: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`${classes.item} ${active ? classes.active : ""}`}
    >
      <span className={classes.icon}>{icon}</span>
      <span className={classes.label}>{label}</span>
      {badge}
    </button>
  );
}
