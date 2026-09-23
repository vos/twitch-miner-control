/**
 * States in which the miner is between lives: no process to stop, and
 * nothing useful to start on top of the one the supervisor is already
 * working towards. Actions are disabled rather than hidden, so the dock
 * keeps its height and the sidebar does not reflow on every transition.
 */
export const TRANSITIONAL = new Set(["STARTING", "RESTARTING"]);

/** The miner is up: the only sensible toggle is to bring it down. */
export const isUp = (state: string | null) => state === "RUNNING";

/**
 * Whether the first status poll has answered yet.
 *
 * An unknown state is not a stopped one: acting on it would offer Start
 * for a miner that may already be running. Every control stays inert
 * until this is true.
 */
export const isKnown = (state: string | null): state is string => state !== null;

/**
 * Why a miner that is not up yet is about to be.
 *
 * At boot the backend checks the drop subscriptions before starting the
 * miner, so it starts on an up-to-date streamer list. That takes seconds,
 * and reading STOPPED meanwhile looks like a miner that failed to start.
 */
export const START_HELD_NOTE =
  "Checking drop subscriptions first, so the miner starts on an "
  + "up-to-date streamer list.";

/**
 * The state to show: STARTING while the boot check holds the start.
 *
 * Only over STOPPED -- a miner already up (Start pressed meanwhile) or
 * crashed is reported as it is.
 */
export const shownState = (state: string | null, startHeld: boolean) =>
  startHeld && state === "STOPPED" ? "STARTING" : state;
