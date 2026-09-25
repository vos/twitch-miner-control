import { randomUUID } from "node:crypto";
import type { Db } from "../db/schema.js";
import type { NotifyKind } from "./catalogue.js";
import { SERVER_TIME_ZONE, defaultPrefs, prefsSchema, type Prefs } from "./prefs.js";

export const INBOX_RETENTION_MS = 30 * 86_400_000;
export const SEEN_RETENTION_MS = 90 * 86_400_000;

/** What `PushSubscription.toJSON()` produces in the browser. */
export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export interface Destination {
  id: string;
  channel: "webpush";
  label: string;
  endpoint: string | null;
  subscription: PushSubscriptionJson | null;
  prefs: Prefs;
  enabled: boolean;
  createdTs: number;
  lastOkTs: number | null;
  lastError: string | null;
  lastErrorTs: number | null;
}

export interface InboxRow {
  id: number;
  ts: number;
  kind: NotifyKind;
  title: string;
  body: string;
  streamer: string | null;
  link: string;
}

interface DestinationRow {
  id: string;
  channel: string;
  label: string;
  endpoint: string | null;
  subscription: string | null;
  prefs: string;
  enabled: number;
  created_ts: number;
  last_ok_ts: number | null;
  last_error: string | null;
  last_error_ts: number | null;
}

function toDestination(row: DestinationRow): Destination {
  // A row whose prefs no longer validate (a kind removed since) reads as
  // the defaults rather than failing every list of destinations.
  const parsed = prefsSchema.safeParse(JSON.parse(row.prefs));
  return {
    id: row.id,
    channel: "webpush",
    label: row.label,
    endpoint: row.endpoint,
    subscription: row.subscription === null ? null : JSON.parse(row.subscription),
    prefs: parsed.success ? parsed.data : defaultPrefs(SERVER_TIME_ZONE),
    enabled: row.enabled === 1,
    createdTs: row.created_ts,
    lastOkTs: row.last_ok_ts,
    lastError: row.last_error,
    lastErrorTs: row.last_error_ts,
  };
}

export class NotifyStore {
  constructor(private readonly db: Db) {}

  list(): Destination[] {
    const rows = this.db
      .prepare("SELECT * FROM notify_destinations ORDER BY created_ts, id")
      .all() as DestinationRow[];
    return rows.map(toDestination);
  }

  get(id: string): Destination | null {
    const row = this.db
      .prepare("SELECT * FROM notify_destinations WHERE id = ?")
      .get(id) as DestinationRow | undefined;
    return row === undefined ? null : toDestination(row);
  }

  byEndpoint(endpoint: string): Destination | null {
    const row = this.db
      .prepare("SELECT * FROM notify_destinations WHERE endpoint = ?")
      .get(endpoint) as DestinationRow | undefined;
    return row === undefined ? null : toDestination(row);
  }

  /**
   * Registers a browser, or refreshes one already known.
   *
   * Matched by the new endpoint first and then by `previousEndpoint`, so
   * a browser that had to re-subscribe (a new VAPID key, a rotated
   * subscription) keeps its label and preferences.
   */
  upsertWebPush(input: {
    subscription: PushSubscriptionJson;
    label: string;
    timeZone: string;
    previousEndpoint?: string;
    now: number;
  }): { destination: Destination; created: boolean } {
    const endpoint = input.subscription.endpoint;
    const existing = this.byEndpoint(endpoint)
      ?? (input.previousEndpoint === undefined ? null : this.byEndpoint(input.previousEndpoint));
    if (existing !== null) {
      this.db
        .prepare("UPDATE notify_destinations SET endpoint = ?, subscription = ? WHERE id = ?")
        .run(endpoint, JSON.stringify(input.subscription), existing.id);
      return { destination: this.get(existing.id)!, created: false };
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO notify_destinations
           (id, channel, label, endpoint, subscription, prefs, enabled, created_ts)
         VALUES (?, 'webpush', ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id, input.label, endpoint, JSON.stringify(input.subscription),
        JSON.stringify(defaultPrefs(input.timeZone)), input.now,
      );
    return { destination: this.get(id)!, created: true };
  }

  update(
    id: string,
    patch: { label?: string; enabled?: boolean; prefs?: Prefs },
  ): Destination | null {
    const current = this.get(id);
    if (current === null) return null;
    this.db
      .prepare("UPDATE notify_destinations SET label = ?, enabled = ?, prefs = ? WHERE id = ?")
      .run(
        patch.label ?? current.label,
        (patch.enabled ?? current.enabled) ? 1 : 0,
        JSON.stringify(patch.prefs ?? current.prefs),
        id,
      );
    return this.get(id);
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM notify_destinations WHERE id = ?").run(id).changes > 0;
  }

  recordOk(id: string, ts: number): void {
    this.db
      .prepare(
        "UPDATE notify_destinations SET last_ok_ts = ?, last_error = NULL, last_error_ts = NULL WHERE id = ?",
      )
      .run(ts, id);
  }

  recordError(id: string, error: string, ts: number): void {
    this.db
      .prepare("UPDATE notify_destinations SET last_error = ?, last_error_ts = ? WHERE id = ?")
      .run(error, ts, id);
  }

  addInbox(row: Omit<InboxRow, "id">): InboxRow {
    const result = this.db
      .prepare(
        "INSERT INTO notifications (ts, kind, title, body, streamer, link) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.ts, row.kind, row.title, row.body, row.streamer, row.link);
    return { id: Number(result.lastInsertRowid), ...row };
  }

  /** Newest first; `before` is an id, for "load more". */
  inbox(before: number | null, limit: number): InboxRow[] {
    return this.db
      .prepare(
        `SELECT id, ts, kind, title, body, streamer, link FROM notifications
          WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
      )
      .all(before, before, limit) as InboxRow[];
  }

  /** Says whether the row existed. */
  removeInbox(id: number): boolean {
    return this.db.prepare("DELETE FROM notifications WHERE id = ?").run(id).changes > 0;
  }

  /** Returns how many rows went. */
  clearInbox(): number {
    return this.db.prepare("DELETE FROM notifications").run().changes;
  }

  /** True the first time a key is seen, false every time after. */
  markSeen(key: string, ts: number): boolean {
    return this.db
      .prepare("INSERT OR IGNORE INTO notify_seen (key, ts) VALUES (?, ?)")
      .run(key, ts).changes === 1;
  }

  /** Returns how many inbox rows went. */
  prune(now: number): number {
    const removed = this.db
      .prepare("DELETE FROM notifications WHERE ts < ?")
      .run(now - INBOX_RETENTION_MS).changes;
    this.db.prepare("DELETE FROM notify_seen WHERE ts < ?").run(now - SEEN_RETENTION_MS);
    return removed;
  }
}
