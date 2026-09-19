import { classOf } from "../lib/appLogLevel.js";
import classes from "./AppEventRow.module.css";

export interface AppEvent {
  time: number;
  level: string;
  type: string;
  msg?: string;
  component?: string;
  [field: string]: unknown;
}

/** The envelope, which is rendered in its own columns rather than as evidence. */
const ENVELOPE = new Set(["time", "level", "type", "msg", "component"]);

/** How long a single field value may get before it is clipped. */
const MAX_VALUE = 120;

/**
 * The evidence fields, as `k=v`, in the order they were logged.
 *
 * Objects are JSON rather than "[object Object]", and long values are
 * clipped -- a pool of thirty channels must not push the next row off
 * the screen. The untruncated value stays available as the title.
 */
export function fieldsOf(event: AppEvent): Array<[string, string]> {
  return Object.entries(event)
    .filter(([key]) => !ENVELOPE.has(key))
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const shown = text === undefined ? "undefined" : text;
      return [
        key,
        shown.length > MAX_VALUE ? `${shown.slice(0, MAX_VALUE)}...` : shown,
      ] as [string, string];
    });
}

/**
 * Formats an event's timestamp for display.
 *
 * The viewer's own timezone, deliberately: the server's would be a
 * second thing to translate while reading. Seconds are included because
 * the sequence within a minute is often the point -- "the pool rebuilt,
 * then the restart was proposed" is only legible if both carry a time.
 */
export function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

/** One app event: what was decided, and the evidence behind it. */
export function AppEventRow({ event }: { event: AppEvent }) {
  const tone = classOf(event.level);
  const fields = fieldsOf(event);
  return (
    <div className={classes.row}>
      <span className={classes.time}>{timeOf(event.time)}</span>
      <span className={`${classes.level} ${classes[tone]}`}>{event.level}</span>
      {event.component !== undefined && (
        <span className={classes.component}>{event.component}</span>
      )}
      <span className={classes.type}>{event.type}</span>
      <span className={`${classes.msg} ${classes[tone]}`}>{event.msg}</span>
      {fields.length > 0 && (
        <span className={classes.fields}>
          {fields.map(([key, value]) => (
            <span key={key} title={`${key}=${value}`}>{key}={value}&nbsp;&nbsp;</span>
          ))}
        </span>
      )}
    </div>
  );
}
