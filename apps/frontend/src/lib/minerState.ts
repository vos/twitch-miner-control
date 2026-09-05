/**
 * States in which the miner is between lives: no process to stop, and
 * nothing useful to start on top of the one the supervisor is already
 * working towards. Actions are disabled rather than hidden, so the dock
 * keeps its height and the sidebar does not reflow on every transition.
 */
export const TRANSITIONAL = new Set(["STARTING", "RESTARTING"]);

/** The miner is up: the only sensible toggle is to bring it down. */
export const isUp = (state: string) => state === "RUNNING";
