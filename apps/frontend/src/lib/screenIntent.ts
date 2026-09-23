/**
 * Where a navigation should land, beyond the screen itself.
 *
 * One-shot: the shell hands these to the screen for the navigation that
 * carried them only, so going back to a screen later does not replay an
 * old jump or prefill.
 */
export interface ScreenParams {
  /** Drops: the campaign to open and scroll to. */
  campaign?: string;
  /** Streamers: text to put in the add box. */
  prefill?: string;
  /** Insights: which recap to open on, at the current period. */
  period?: "week" | "month";
}

/**
 * One navigation's params, numbered.
 *
 * The id is what a screen reacts to. Two jumps to the same campaign are
 * equal by value, and without the id the second would do nothing.
 */
export interface ScreenIntent {
  params: ScreenParams;
  id: number;
}

/** A single param together with the id of the navigation that carried it. */
export interface Stamped<T> {
  value: T;
  id: number;
}

/** Picks one param out of an intent, or null when it is not there. */
export function stamped<K extends keyof ScreenParams>(
  intent: ScreenIntent | null,
  key: K,
): Stamped<NonNullable<ScreenParams[K]>> | null {
  const value = intent?.params[key];
  if (intent === null || value === undefined) return null;
  return { value: value as NonNullable<ScreenParams[K]>, id: intent.id };
}
