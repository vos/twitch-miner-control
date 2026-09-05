import { Avatar } from "@mantine/core";

/**
 * A streamer's profile picture, linking to their Twitch channel.
 *
 * The href is built from the login, never the display name: display names
 * carry non-ASCII characters on plenty of channels and do not resolve as
 * URLs, while the login is the canonical channel path.
 *
 * Mantine's Avatar handles both failure modes on its own -- a null src and
 * an image that 404s -- by falling back to `children`, so a dead CDN URL
 * degrades to the monogram with no extra code here. `color="initials"`
 * derives a stable hue from the name, so a given streamer keeps the same
 * colour across renders and reloads.
 */
export function StreamerAvatar({ login, displayName, avatarUrl, size = 40, live = false }: {
  login: string;
  displayName?: string | null;
  avatarUrl: string | null;
  size?: number;
  live?: boolean;
}) {
  const name = displayName ?? login;
  return (
    <a
      href={`https://twitch.tv/${login}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${name} on Twitch`}
      style={{ display: "flex", flexShrink: 0, lineHeight: 0 }}
    >
      <Avatar
        src={avatarUrl}
        // Decorative: the name is always rendered next to it, and a
        // screen reader must not announce the same streamer twice.
        alt=""
        name={name}
        color="initials"
        size={size}
        radius="xl"
        style={live
          ? { outline: "2px solid var(--tw-live)", outlineOffset: 2 }
          : undefined}
      >
        {name.charAt(0).toUpperCase()}
      </Avatar>
    </a>
  );
}
