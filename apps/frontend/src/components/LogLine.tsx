import { levelOf } from "../lib/logLevel.js";
import classes from "./LogLine.module.css";

export function LogLine({ text }: { text: string }) {
  return <div className={`${classes.line} ${classes[levelOf(text)]}`}>{text}</div>;
}
