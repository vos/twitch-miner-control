import { z } from "zod";
import { usernameSchema } from "../config/schema.js";
import { ALL_KINDS, kindInfo, type Notification, type NotifyKind } from "./catalogue.js";

/** The zone this process runs in: `TZ`, or the container default. */
export const SERVER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");

export const prefsSchema = z
  .object({
    /** Absent kind: the catalogue default. */
    kinds: z.partialRecord(z.enum(ALL_KINDS), z.boolean()),
    /** For the streamers group only. */
    streamers: z.union([z.literal("all"), z.array(usernameSchema).max(500)]),
    quietHours: z
      .object({ from: hhmm, to: hhmm, allowHealth: z.boolean() })
      .strict()
      .nullable(),
    /** IANA zone that quietHours and digestAt are read in. */
    timeZone: z.string().refine(isTimeZone, "unknown time zone"),
    digestAt: hhmm,
  })
  .strict();

export type Prefs = z.infer<typeof prefsSchema>;
export type QuietHours = NonNullable<Prefs["quietHours"]>;

export function defaultPrefs(timeZone: string): Prefs {
  return {
    kinds: {},
    streamers: "all",
    quietHours: null,
    timeZone: isTimeZone(timeZone) ? timeZone : SERVER_TIME_ZONE,
    digestAt: "09:00",
  };
}

/** Minutes since midnight. The input has already passed `hhmm`. */
export function parseHhmm(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    // en-CA formats the date as YYYY-MM-DD; h23 keeps midnight at "00".
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall-clock date and minute of `ts` in `timeZone`. */
export function localClock(ts: number, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    formatter(timeZone).formatToParts(ts).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** `from` inclusive, `to` exclusive; a window with equal ends is empty. */
export function inQuietHours(quiet: QuietHours | null, timeZone: string, ts: number): boolean {
  if (quiet === null) return false;
  const from = parseHhmm(quiet.from);
  const to = parseHhmm(quiet.to);
  if (from === to) return false;
  const now = localClock(ts, timeZone).minutes;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function kindEnabled(prefs: Prefs, kind: NotifyKind): boolean {
  return prefs.kinds[kind] ?? kindInfo(kind).defaultOn;
}

/** Whether this destination takes `kind` at `ts`, before any streamer filter. */
export function wantsKind(prefs: Prefs, kind: NotifyKind, ts: number): boolean {
  if (!kindEnabled(prefs, kind)) return false;
  if (inQuietHours(prefs.quietHours, prefs.timeZone, ts)) {
    return prefs.quietHours!.allowHealth && kindInfo(kind).group === "health";
  }
  return true;
}

export function wants(
  prefs: Prefs,
  n: Pick<Notification, "kind" | "streamer">,
  ts: number,
): boolean {
  if (!wantsKind(prefs, n.kind, ts)) return false;
  if (kindInfo(n.kind).group !== "streamers" || prefs.streamers === "all") return true;
  const login = n.streamer?.login.toLowerCase();
  return login !== undefined && prefs.streamers.some((s) => s.toLowerCase() === login);
}
