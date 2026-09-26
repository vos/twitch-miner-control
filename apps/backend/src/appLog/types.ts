/**
 * Every app event type, in one place.
 *
 * A typo in a `type` string would not break anything at runtime -- it
 * would write a line nobody ever filters for, which is worse than a
 * crash because the log would look healthy while quietly missing the
 * event someone went looking for. Naming them here makes that a compile
 * error instead.
 *
 * The taxonomy records DECISIONS AND THEIR EVIDENCE, not activity. A
 * routine pass that changes nothing earns a debug line at most; anything
 * logged at info should be something a reader would want to know happened
 * while they were not watching. That rule is what keeps a week of log
 * readable, and it is the reason there is no request logging, no per-tick
 * polling line and no point-gain events here (gains belong to the
 * `events` table, which the miner feeds through the doorbell).
 */
export const EVENT = {
  // --- drops: subscription resolution -------------------------------
  /** A resolve pass began. Carries WHY it ran, which was unknowable before. */
  PASS_START: "subscription.pass.start",
  /** The pass resolved the same channels it started with. */
  PASS_NOOP: "subscription.pass.noop",
  /** A pass threw; the config still holds the previous working pool. */
  PASS_FAILED: "subscription.pass.failed",
  /** A pool kept because at least one member is still live. */
  POOL_KEPT: "subscription.pool.kept",
  /** A pool rebuilt because nobody in it was live any more. */
  POOL_REBUILT: "subscription.pool.rebuilt",
  /** Resolution could not answer, so the existing pool was left alone. */
  DEGRADED: "subscription.degraded",
  /** A directory lookup failed for one subscription. */
  DIRECTORY_FAILED: "subscription.directory.failed",
  /** A campaign left a trustworthy catalogue or passed its end date, so
   * its subscription was removed. `reason` says which. */
  SUBSCRIPTION_ENDED: "subscription.ended",
  /** Every obtainable drop was earned, so the subscription was removed. */
  SUBSCRIPTION_COMPLETED: "subscription.completed",
  /** A campaign not yet open was subscribed; channels wait for its start. */
  SUBSCRIPTION_SCHEDULED: "subscription.scheduled",
  /** A scheduled campaign opened, so its channels are being resolved. */
  SUBSCRIPTION_OPENED: "subscription.opened",
  /** A followed game's campaign was subscribed to automatically. */
  SUBSCRIPTION_FOLLOWED: "subscription.followed",
  /** The campaign queue moved on: a waiting subscription became active. */
  QUEUE_STARTED: "subscription.queue.started",
  /** The streamer list actually changed, and how. */
  RECONCILED: "subscription.reconciled",

  // --- miner: supervision -------------------------------------------
  MINER_STATE: "miner.state",
  MINER_SPAWN_FAILED: "miner.spawn.failed",
  /** Exited too fast to be worth retrying: config or environment is broken. */
  MINER_UNSTARTABLE: "miner.exit.unstartable",
  /** A crash earned a backoff, with the crash-rate evidence behind it. */
  MINER_RESTART_SCHEDULED: "miner.restart.scheduled",
  /** The crash-rate cap tripped; no further automatic restarts. */
  MINER_GAVE_UP: "miner.restart.gaveUp",
  /** SIGTERM was ignored and the grace period ran out. */
  MINER_SIGKILL: "miner.sigkill",

  // --- the deferred restart -----------------------------------------
  RESTART_PROPOSED: "restart.proposed",
  RESTART_FIRED: "restart.fired",
  RESTART_FAILED: "restart.failed",

  // --- user decisions ------------------------------------------------
  USER_MINER_ACTION: "user.miner.action",
  USER_CONFIG_APPLIED: "user.config.applied",
  USER_CONFIG_FAILED: "user.config.applyFailed",
  USER_SUB_ADDED: "user.subscription.added",
  USER_SUB_REMOVED: "user.subscription.removed",
  USER_SUB_REORDERED: "user.subscription.reordered",
  USER_SUB_POOL_SIZE: "user.subscription.poolSize",
  USER_SUB_QUEUE: "user.subscription.queue",
  USER_GAME_FOLLOWED: "user.game.followed",
  USER_GAME_UNFOLLOWED: "user.game.unfollowed",
  USER_GAME_POOL_SIZE: "user.game.poolSize",
  USER_GAME_UNSKIPPED: "user.game.unskipped",
  /** The operator vetoed a restart the engine wanted. */
  USER_RESTART_CANCELLED: "user.restart.cancelled",
  USER_RESTART_FORCED: "user.restart.forced",
  USER_TWITCH_LOGIN: "user.twitch.login",
  USER_TWITCH_LOGOUT: "user.twitch.logout",

  // --- auth -----------------------------------------------------------
  AUTH_OK: "auth.login.ok",
  AUTH_FAILED: "auth.login.failed",
  AUTH_THROTTLED: "auth.login.throttled",

  // --- the campaign catalogue ------------------------------------------
  CATALOGUE_FETCHED: "catalogue.fetched",
  /** Serving old campaigns because a fetch failed. Feeds the `trustworthy`
   * test in the drops engine, so it explains ended-campaign decisions. */
  CATALOGUE_STALE: "catalogue.stale",

  // --- notifications -------------------------------------------------
  /** A browser turned notifications on. */
  NOTIFY_DESTINATION_ADDED: "notify.destination.added",
  /** A browser was removed from the Notifications screen. */
  NOTIFY_DESTINATION_REMOVED: "notify.destination.removed",
  /** The push service said the subscription is gone, so the row was deleted. */
  NOTIFY_DEVICE_EXPIRED: "notify.device.expired",
  /** A delivery failed, or a publish threw. */
  NOTIFY_FAILED: "notify.failed",

  // --- app lifecycle ----------------------------------------------------
  APP_STARTED: "app.started",
  APP_SHUTDOWN: "app.shutdown",
  APP_PRUNED: "app.retention.pruned",
  APP_FOLLOWERS_FAILED: "app.roster.followersFailed",
} as const;

/** Every value of EVENT, so a malformed type cannot be logged. */
export type EventType = (typeof EVENT)[keyof typeof EVENT];

/** The components events are grouped under, for filtering in the UI. */
export const COMPONENT = {
  DROPS: "drops",
  MINER: "miner",
  HTTP: "http",
  AUTH: "auth",
  CATALOGUE: "catalogue",
  NOTIFY: "notify",
  APP: "app",
} as const;

export type Component = (typeof COMPONENT)[keyof typeof COMPONENT];
