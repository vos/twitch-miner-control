import type { AppEvent, AppLog } from "./port.js";

/** An event as the double recorded it: what was logged, plus how. */
export interface RecordedEvent extends AppEvent {
  level: "debug" | "info" | "warn" | "error";
  /** Absent when logged through the root rather than a child. */
  component?: string;
}

export interface MemoryLog extends AppLog {
  /** Everything logged through this instance OR any child of it, in order. */
  readonly events: RecordedEvent[];
  /** Just the events of one type, which is what most assertions want. */
  ofType(type: string): RecordedEvent[];
}

/**
 * An AppLog that records into an array, for tests.
 *
 * Lives here rather than in a .test.ts because most of its users are the
 * tests of OTHER modules -- the supervisor's, the engine's -- which need
 * to assert on the decisions those modules announce.
 *
 * Children share the parent's array rather than keeping their own, so a
 * test that injects one logger into a module which then takes a child of
 * it still sees everything in one ordered list. Order across components
 * is the point: the sequence "pool rebuilt, then restart proposed" is
 * exactly the kind of interaction this whole feature exists to make
 * visible, and two separate arrays could not show it.
 */
export function memoryLog(): MemoryLog {
  const events: RecordedEvent[] = [];

  const make = (component?: string): MemoryLog => {
    const record = (level: RecordedEvent["level"]) => (event: AppEvent) => {
      events.push(component === undefined
        ? { ...event, level }
        : { ...event, level, component });
    };
    return {
      events,
      ofType: (type) => events.filter((e) => e.type === type),
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      // A child of a child re-binds rather than nesting: the last
      // component named wins, matching how pino's own bindings behave.
      child: (bindings) => make(bindings.component),
    };
  };

  return make();
}
