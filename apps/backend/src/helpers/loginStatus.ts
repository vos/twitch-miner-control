/**
 * Whether the stored Twitch session is currently usable.
 *
 * This exists because `loginRequired` used to be derived from
 * `LoginRunner#current` -- the progress of a login *attempt made by this
 * process*. That answers a different question: it is null after every
 * restart (so a fully logged-in user was told to sign in), and it stays
 * "ok" forever once any attempt succeeded (so a token that expired an hour
 * later was never reported at all). The real answer comes from two places
 * that both live outside the HTTP layer:
 *
 *   - the `check_login` round trip index.ts already makes at boot, whose
 *     result was previously thrown away, and
 *   - `code: "AUTH"` on a later helper response (python/helpers/state.py),
 *     which is emitted precisely when the helper reloaded the cookie pickle
 *     and *still* could not authenticate -- i.e. the session is dead, not
 *     merely a flaky request.
 *
 * Deliberately not driven by a *failed* login attempt: a user who fumbles a
 * device code while holding a perfectly good session has not lost it.
 */
export class LoginStatus {
  private loggedIn = false;

  /** True when the user must sign in to Twitch again. */
  get required(): boolean {
    return !this.loggedIn;
  }

  markLoggedIn(): void {
    this.loggedIn = true;
  }

  markLoggedOut(): void {
    this.loggedIn = false;
  }
}
