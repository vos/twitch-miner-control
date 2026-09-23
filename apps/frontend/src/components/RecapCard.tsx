import type { Ref } from "react";
import type { RecapChannel, RecapPayload } from "../api/useInsights.js";
import { parseDayKey } from "../lib/days.js";
import { changeLabel, formatHoursMinutes, periodLabel } from "../lib/insightsFormat.js";
import { BrandMark } from "./BrandMark.js";
import classes from "./RecapCard.module.css";

const nf = new Intl.NumberFormat("en-US");
const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * A channel's picture, loadable into a PNG capture: Twitch's CDN sends
 * Access-Control-Allow-Origin: *, and crossOrigin="anonymous" is what
 * lets the capture use it without tainting the canvas.
 */
function Avatar({ channel }: { channel: RecapChannel }) {
  const name = channel.displayName ?? channel.login;
  if (channel.avatarUrl === null) {
    return <span className={classes.avatar}>{name.slice(0, 1).toUpperCase()}</span>;
  }
  return <img className={classes.avatar} src={channel.avatarUrl} alt="" crossOrigin="anonymous" />;
}

/**
 * A week or month in figures, laid out to be screenshotted and shared.
 *
 * A partial period makes no comparison: a week so far against a whole
 * week before it would always read as a drop.
 */
export function RecapCard({ recap, ref }: { recap: RecapPayload; ref?: Ref<HTMLDivElement> }) {
  const { period, totals, previous, top, mostWatched, highlights } = recap;
  const compare = !period.partial && previous !== null;
  const vs = period.kind === "week" ? "vs last week" : "vs last month";
  const empty = totals.earned === 0 && totals.minedMs === 0;

  const change = (kind: "earned" | "mined" | "uptime", now: number, prev: number) => {
    if (!compare) return null;
    const label = changeLabel(kind, now, prev);
    return label === null ? null : <div className={classes.change}>{kind === "earned" ? `${label} ${vs}` : label}</div>;
  };

  const extras = [
    highlights.bestDay !== null && `Best day ${parseDayKey(highlights.bestDay.date)
      .toLocaleDateString("en-US", { weekday: "short" })} · ${nf.format(highlights.bestDay.earned)}`,
    highlights.bonusClaims > 0 && `🎁 ${highlights.bonusClaims} chests`,
    highlights.raids > 0 && `⚔ ${highlights.raids} raid${highlights.raids === 1 ? "" : "s"}`,
    highlights.dropsClaimed > 0
      && `🏆 ${highlights.dropsClaimed} drop${highlights.dropsClaimed === 1 ? "" : "s"} claimed`,
    highlights.longestStreak > 1 && `🔥 ${highlights.longestStreak}-day streak`,
    highlights.watchStreakBonuses > 0 && `📺 ${highlights.watchStreakBonuses} watch-streak bonuses`,
  ].filter((entry): entry is string => typeof entry === "string");

  return (
    <div ref={ref} className={classes.card} data-testid="recap-card">
      <div className={classes.header}>
        <span>✦ {periodLabel(period)}</span>
        <BrandMark size={28} />
      </div>

      {empty ? (
        <p className={classes.caption} data-testid="recap-empty">
          Nothing mined in this {period.kind}.
        </p>
      ) : (
        <>
          <div className={classes.figures}>
            <div>
              <div className={classes.figure} data-testid="recap-earned">{nf.format(totals.earned)}</div>
              <div className={classes.caption}>points earned</div>
              {change("earned", totals.earned, previous?.earned ?? 0)}
            </div>
            <div>
              <div className={classes.figure}>{formatHoursMinutes(totals.minedMs)}</div>
              <div className={classes.caption}>mined</div>
              {change("mined", totals.minedMs, previous?.minedMs ?? 0)}
            </div>
            <div>
              <div className={classes.figure}>{totals.uptimePct}%</div>
              <div className={classes.caption}>miner uptime</div>
              {change("uptime", totals.uptimePct, previous?.uptimePct ?? 0)}
            </div>
          </div>

          {top.length > 0 && (
            <div data-testid="recap-top">
              <div className={classes.section}>TOP CHANNELS</div>
              {top.map((channel, i) => (
                <div key={channel.login} className={classes.channel}>
                  <span>{MEDALS[i]}</span>
                  <Avatar channel={channel} />
                  <span>{channel.displayName ?? channel.login}</span>
                  <span className={classes.points}>{nf.format(channel.earned)}</span>
                </div>
              ))}
              {mostWatched !== null && (
                <div className={classes.caption}>
                  most watched: {mostWatched.displayName ?? mostWatched.login}
                  {" · "}{formatHoursMinutes(mostWatched.minedMs)}
                </div>
              )}
            </div>
          )}

          {extras.length > 0 && (
            <div className={classes.highlights} data-testid="recap-highlights">
              {extras.map((entry) => <span key={entry}>{entry}</span>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
