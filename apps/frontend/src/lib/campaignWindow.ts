import { formatDateHour } from "./formatClock.js";
import { formatSpan } from "./formatSpan.js";

/**
 * The exact dates behind a campaign's countdown, and how it stands now.
 *
 * The countdown itself is deliberately coarse -- formatSpan rounds to a
 * single unit, so "4d left" covers anything from three and a half days
 * to four and a half. That is the right trade for a card being scanned,
 * but it leaves no way to answer "do I have until Friday or Saturday?",
 * which is exactly what someone deciding whether to start a campaign
 * needs to know. The dates live behind a tap so the card stays scannable
 * and the precision is one interaction away.
 *
 * Returned as fields rather than formatted lines: the panel lays them
 * out as a label/value pair, so padding them into aligned strings here
 * would be styling the data and would fight the theme's own type.
 *
 * Both dates are always reported, including the start of a campaign
 * already running: "when did this open" is how you tell a fresh campaign
 * from one nearly over, and the elapsed bar beside it is meaningless
 * without it. A campaign missing a date omits that row rather than
 * inventing one.
 *
 * `state` restates the countdown in words. It repeats the badge
 * deliberately: the dates above it are absolute, and reading which side
 * of "now" they fall on is work the panel can do for the reader.
 */
export interface CampaignWindow {
  rows: { label: string; value: string }[];
  state: string | null;
}

export function windowLines(
  startsAt: number | null,
  endsAt: number | null,
  now: number,
): CampaignWindow {
  const rows: { label: string; value: string }[] = [];
  if (startsAt !== null) {
    rows.push({ label: "Starts", value: formatDateHour(startsAt) });
  }
  if (endsAt !== null) {
    rows.push({ label: "Ends", value: formatDateHour(endsAt) });
  }
  if (rows.length === 0) return { rows: [], state: null };

  let state: string | null = null;
  if (endsAt !== null && endsAt <= now) {
    state = `ended ${formatSpan(now - endsAt)} ago`;
  } else if (startsAt !== null && startsAt > now) {
    state = `opens in ${formatSpan(startsAt - now)}`;
  } else if (startsAt !== null) {
    state = `started ${formatSpan(now - startsAt)} ago`;
  }
  return { rows, state };
}

export function narrowerWindow(
  drop: { startsAt?: number | null; endsAt?: number | null },
  campaignStartsAt: number | null,
  campaignEndsAt: number | null,
): { startsAt: number | null; endsAt: number | null } | null {
  const startsAt = drop.startsAt ?? null;
  const endsAt = drop.endsAt ?? null;
  if (startsAt === null && endsAt === null) return null;
  const laterStart = startsAt !== null && campaignStartsAt !== null
    && startsAt > campaignStartsAt;
  const earlierEnd = endsAt !== null && campaignEndsAt !== null
    && endsAt < campaignEndsAt;
  if (!laterStart && !earlierEnd) return null;
  return { startsAt, endsAt };
}
