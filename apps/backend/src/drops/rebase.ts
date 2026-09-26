import type { AppConfig, FollowedGame, Subscription } from "../config/schema.js";
import { reconcile, type DesiredEntry, type Reconciliation } from "./reconcile.js";

/** What one engine pass decided, against the config it started from. */
export interface PassOutcome {
  /** Subscriptions the pass ended. */
  ended: ReadonlySet<string>;
  /** Subscriptions the pass added for followed games. */
  added: readonly Subscription[];
  /** Every subscription the pass considered, added ones included. */
  considered: ReadonlySet<string>;
  /** The channels the pass wants, in rank order. */
  desired: readonly DesiredEntry[];
  /** The followed games as the pass read them, and as it would leave them. */
  gamesBefore: readonly FollowedGame[];
  gamesAfter: readonly FollowedGame[];
}

/**
 * An engine pass's decisions, applied to the config as it is now.
 *
 * A pass reads the config, then spends seconds asking Twitch; routes save
 * in between. Writing the config the pass started from would undo those
 * saves -- a game followed or unfollowed, a subscription removed -- so
 * only what the pass itself decided is applied on top of the current one.
 */
export function rebasePass(
  current: AppConfig,
  pass: PassOutcome,
): { config: AppConfig; reconciliation: Reconciliation } {
  const before = new Map(pass.gamesBefore.map((g) => [g.id, g]));
  const after = new Map(pass.gamesAfter.map((g) => [g.id, g]));
  const followedGames = current.followedGames.map((game) => {
    const was = before.get(game.id);
    const now = after.get(game.id);
    if (was === undefined || now === undefined) return game;
    const dropped = was.skipped.filter((id) => !now.skipped.includes(id));
    const recorded = now.skipped.filter((id) => !was.skipped.includes(id));
    if (dropped.length === 0 && recorded.length === 0) return game;
    return {
      ...game,
      skipped: [
        ...game.skipped.filter((id) => !dropped.includes(id)),
        ...recorded.filter((id) => !game.skipped.includes(id)),
      ],
    };
  });

  // An addition stands only while its game is still followed and has not
  // skipped it, and nothing else has subscribed to the campaign meanwhile.
  let rank = current.subscriptions.reduce((max, s) => Math.max(max, s.rank), -1);
  const kept = pass.added
    .filter((s) => !current.subscriptions.some((c) => c.targetId === s.targetId))
    .filter((s) => followedGames.some(
      (g) => g.id === s.viaGame && !g.skipped.includes(s.targetId),
    ))
    .map((s) => ({ ...s, rank: ++rank }));
  const subscriptions = [
    ...current.subscriptions.filter((s) => !pass.ended.has(s.id)),
    ...kept,
  ];

  // Channels of a subscription the pass never saw are carried as they
  // are; the next pass resolves it properly.
  const live = new Set(subscriptions.map((s) => s.id));
  const untouched = current.streamers
    .filter((s) => s.ownedBy !== undefined && live.has(s.ownedBy)
      && !pass.considered.has(s.ownedBy))
    .map((s) => ({ username: s.username, ownedBy: s.ownedBy! }));
  const reconciliation = reconcile(current.streamers, [
    ...pass.desired.filter((d) => live.has(d.ownedBy)),
    ...untouched,
  ]);

  return {
    config: { ...current, followedGames, subscriptions, streamers: reconciliation.streamers },
    reconciliation,
  };
}
