import type { Db } from "./schema.js";

export interface DailyRow {
  day: string;
  streamer: string;
  earned: number;
}

/**
 * Points earned per streamer per complete local day.
 *
 * Its own store rather than part of `History`: History's point table is
 * pruned, and this one exists precisely to outlive that. A day, once
 * written, is final -- recomputing it after its snapshots were pruned
 * would replace a correct row with a partial one.
 */
export class DailyPoints {
  constructor(private readonly db: Db) {}

  /** Whether any row has been written for the day. */
  has(day: string): boolean {
    return this.db
      .prepare("SELECT 1 FROM daily_points WHERE day = ? LIMIT 1")
      .get(day) !== undefined;
  }

  /** Writes a day's rows in one transaction. A day already written is left alone. */
  write(day: string, earned: Map<string, number>): void {
    const insert = this.db.prepare(
      `INSERT INTO daily_points (day, streamer, earned) VALUES (?, ?, ?)
       ON CONFLICT (day, streamer) DO NOTHING`,
    );
    this.db.transaction(() => {
      for (const [streamer, points] of earned) insert.run(day, streamer, points);
    })();
  }

  /** Rows from `fromDay` to `toDay` inclusive, by day then streamer. */
  between(fromDay: string, toDay: string): DailyRow[] {
    return this.db
      .prepare(
        `SELECT day, streamer, earned FROM daily_points
          WHERE day >= ? AND day <= ? ORDER BY day, streamer`,
      )
      .all(fromDay, toDay) as DailyRow[];
  }

  /** The earliest day with a row, or null when nothing has been rolled up. */
  firstDay(): string | null {
    const row = this.db
      .prepare("SELECT MIN(day) AS day FROM daily_points")
      .get() as { day: string | null };
    return row.day;
  }
}
