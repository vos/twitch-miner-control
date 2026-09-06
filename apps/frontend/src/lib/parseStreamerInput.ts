/**
 * Extracts a Twitch login from whatever was pasted into the add field.
 *
 * Copying a streamer from the browser gives you a URL, not a login, so the
 * field accepts both and hands the rest of the app the bare username: the
 * duplicate check, the lookup route and `config.json` all key on the login,
 * and `usernameSchema` (backend) rejects anything with a slash in it.
 *
 * Returns null when nothing username-shaped is left, so the caller can say
 * so instead of sending a doomed lookup.
 */
export function parseStreamerInput(input: string): string | null {
  let value = input.trim();

  // Accept twitch.tv/name, www.twitch.tv/name and either scheme. The host
  // is matched explicitly rather than stripping any leading URL-ish text:
  // a link to some other site is a mistake worth reporting, not worth
  // silently mining the last path segment of. The path must be that one
  // segment, so /directory/game/Chess and /name/videos are refused rather
  // than mined as "directory" and "name".
  const url =
    /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*twitch\.tv\/([^/?#]+)\/?(?:[?#].*)?$/i.exec(value);
  if (url) {
    value = url[1];
  } else if (value.includes("/")) {
    return null;
  }

  // A pasted link can still carry a trailing query or fragment when the
  // host did not match -- and "@name" is how people write a handle.
  value = value.replace(/^@/, "").split(/[?#]/)[0];

  return /^[a-zA-Z0-9_]{4,25}$/.test(value) ? value : null;
}
