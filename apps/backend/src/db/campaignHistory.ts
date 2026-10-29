import type { Db } from "./schema.js";
import type { ResolvedCampaign } from "../state/dropState.js";

/**
 * Every campaign this account made progress on, as it last looked.
 *
 * The catalogue holds only what is running, so a campaign that ends
 * leaves it -- and with it the only record of what it was and what was
 * earned. This keeps that record, from the account's own progress
 * rather than the tracker: it covers only campaigns actually watched,
 * but it is ours, and outlives any change at the source.
 *
 * One row per campaign holding its last snapshot, kept forever: a few
 * kilobytes each, for campaigns that run for days.
 */
export class CampaignHistory {
  constructor(private readonly db: Db) {}

  /**
   * Stores a campaign's current state; true when that changed anything.
   *
   * Recorded on a timer for as long as a campaign runs, so an unchanged
   * snapshot is not written again.
   */
  record(campaign: ResolvedCampaign, ts = Date.now()): boolean {
    const snapshot = JSON.stringify(campaign);
    const held = this.db
      .prepare("SELECT snapshot FROM campaign_history WHERE campaign_id = ?")
      .get(campaign.id) as { snapshot: string } | undefined;
    if (held?.snapshot === snapshot) return false;
    this.db
      .prepare(
        `INSERT INTO campaign_history (campaign_id, first_seen_ts, updated_ts, ends_at, snapshot)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (campaign_id) DO UPDATE SET
           updated_ts = excluded.updated_ts,
           ends_at = excluded.ends_at,
           snapshot = excluded.snapshot`,
      )
      .run(campaign.id, ts, ts, campaign.endsAt, snapshot);
    return true;
  }

  /** Every recorded campaign, the most recently ended first. */
  all(): ResolvedCampaign[] {
    const rows = this.db
      .prepare(
        // An unknown end sorts last: it says nothing about recency.
        `SELECT snapshot FROM campaign_history
          ORDER BY ends_at IS NULL, ends_at DESC, updated_ts DESC`,
      )
      .all() as { snapshot: string }[];
    return rows.map((row) => JSON.parse(row.snapshot) as ResolvedCampaign);
  }
}
