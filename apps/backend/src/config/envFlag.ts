/**
 * Resolves an opt-in boolean environment variable.
 *
 * Used for the two flags that move this app off its documented LAN
 * deployment and behind a TLS-terminating reverse proxy: SECURE_COOKIE and
 * TRUST_PROXY. Both stay off unless deliberately turned on.
 *
 * On SECURE_COOKIE specifically, which sets `secure` on the session cookie:
 * `secure` tells the browser never to send the cookie over plain HTTP. That
 * is what makes a reverse proxy actually protective: without it, a session
 * minted over HTTPS is still replayed in the clear the moment anything
 * reaches the app by HTTP -- a stray bookmark, a redirect, a LAN client
 * hitting port 8080 directly -- which is the exact leak the proxy was added
 * to close.
 *
 * It cannot default to on. The documented setup is LAN-only over plain HTTP
 * (see the README), and a `secure` cookie on an HTTP origin is dropped by the
 * browser silently: login would appear to succeed, then every subsequent
 * request would 401 with nothing in the logs to explain it. So the safe
 * default is the one that works for the documented deployment, and TLS
 * deployments opt in.
 *
 * Anything unrecognised is treated as *on*, unlike the numeric resolvers
 * which fall back to their default. The asymmetry is deliberate: the failure
 * mode of wrongly enabling this is a visibly broken login, while the failure
 * mode of wrongly ignoring it is a silently insecure cookie on a host the
 * operator believed they had secured. Loud beats quiet.
 */
export function resolveEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  // A bare `SECURE_COOKIE=` in .env reads as unset, matching how the other
  // resolvers treat an empty value.
  if (normalized === "") return false;
  return !["0", "false", "no", "off"].includes(normalized);
}
