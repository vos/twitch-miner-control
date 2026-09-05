# Streamer avatars and Twitch profile links

Status: approved for planning
Date: 2026-09-05

## Goal

Give the roster a face. Every streamer surface currently renders a login
string and nothing else, which makes a twenty-channel dashboard a wall of
text that has to be *read* rather than recognised. Show each streamer's
Twitch profile picture, and make the avatar and name a link to their
Twitch channel.

## Decisions

Settled with the user before writing this spec:

- **Lazy per-streamer fetch, cached in SQLite.** Not a piggyback on the
  follow list. See "Why not the follow list" below.
- **The browser loads image bytes straight from Twitch's CDN.** The backend
  serves only the URL string. No image proxy, no bytes on disk.
- **Seven-day TTL** on a cached avatar URL.
- **Monogram fallback**: initial letter on a colour derived from the login.
- **Three surfaces**: dashboard cards, the Streamers config rows, and a
  live/offline visual distinction on the avatar itself.

### Why not the follow list

The obvious free source is `channel_follows`. The miner's parser already
reads `profileImageURL` for every follow
(`vendor/miner/TwitchChannelPointsMiner/classes/gql/data/Parser.py:227`)
and `Integration.channel_follows` then discards everything but the login
(`Integration.py:427`). Returning the URL alongside costs zero extra API
calls.

It was rejected because it covers the wrong set. The roster is a *union* of
followed channels and hand-added ones (`apps/backend/src/state/roster.ts`),
and the hand-added ones are precisely the channels the user cared enough to
type in. Covering only followers would leave those — the most deliberate
entries on the dashboard — as permanent monograms, and would put avatar
coverage at the mercy of a setting (`followers`) that has nothing to do with
avatars.

The lazy path covers every streamer by the same rule, at a cost of one GQL
call per *new* streamer and none thereafter.

### Why no image proxy

The user's original framing asked for "a backend endpoint". It is not
needed, and saying so is part of this design.

The app serves no `Content-Security-Policy` (verified: no CSP header is set
anywhere in `apps/backend/src`), so an `<img>` pointing at
`static-cdn.jtvnw.net` loads normally. A proxy would add disk growth, an
eviction policy, content-type handling and a new failure mode, in exchange
for hiding a CDN request from a LAN tool whose entire job is talking to
Twitch. The URL is cached; the bytes are the browser's problem.

## Architecture

The avatar URL is a **derived, cached attribute of a streamer**, resolved on
a separate track from the balance poll:

```
StateService.doRefresh()            [every 60s, unchanged]
  |
  +-- helper "state" -------------> balances, online, displayName
  |
  +-- AvatarCache.resolve(logins)   [new, must not block or fail the above]
        |
        +-- fresh row (< 7d) ------> URL from SQLite
        +-- missing / stale -------> helper "avatars" op --> GQL
                                       |
                                       +-- write through to SQLite
```

`avatarUrl` is merged into each `StreamerState`, so it reaches the browser
on the **existing** `/api/streamers` response and SSE `state` frame. No new
HTTP route, no second frontend fetch, no new loading state.

Three properties this arrangement must preserve:

1. **An avatar failure is never a state error.** It resolves to `null`, the
   card renders a monogram, the poll is untouched. Avatar failures must not
   reach `snapshot.error`, and must not trip the `auth-error` path that
   signs the user out of the UI.
2. **Avatar work must not widen the balance poll.** Resolution happens after
   the `state` response is in hand. A slow lookup delays a subsequent
   `change` emit, never the current one.
3. **A newly added streamer renders without an avatar on its first pass.**
   It appears on the next refresh. The alternative — blocking the dashboard
   on GQL calls for a cosmetic field — is worse.

## Backend

### Table: `streamer_profiles`

New, in the existing `CREATE TABLE IF NOT EXISTS` block in
`apps/backend/src/db/schema.ts`:

```sql
CREATE TABLE IF NOT EXISTS streamer_profiles (
  login      TEXT PRIMARY KEY,   -- normalised, per normaliseUsername()
  avatar_url TEXT,               -- NULL = asked Twitch, no avatar found
  fetched_at INTEGER NOT NULL
);
```

`avatar_url` is nullable and that is load-bearing. It distinguishes *"we
asked and there is none"* from *"we never asked"* (no row at all). Collapse
those two and a streamer whose lookup legitimately yields nothing gets
re-fetched on every poll, forever.

The `login` key is the normalised form from `roster.ts:normaliseUsername`,
so the cache keys match the roster's own dedupe keys and a differently-cased
config entry cannot produce a second row for the same channel.

### `apps/backend/src/state/avatars.ts` *(new)*

An `AvatarCache` class with one public method:

```ts
resolve(logins: string[]): Promise<Map<string, string | null>>
```

It reads the cached rows, partitions into fresh / stale / missing, requests
only what needs requesting, writes results through to SQLite, and returns
the merged map. It **swallows its own errors**, returning what it has rather
than rejecting — property 1 above depends on this.

**Batch cap.** At most `MAX_FETCH_PER_PASS` (10) lookups per resolve. Adding
fifty followed channels at once must not fire fifty GQL calls inside one
refresh; the remainder fill in over subsequent passes. This also keeps a
batch comfortably inside `NdjsonClient`'s 30s request timeout
(`apps/backend/src/helpers/ndjsonClient.ts:66`), which a fifty-name batch
would otherwise threaten.

Separated into its own module rather than living in `service.ts` for the
same reason `gains.ts` is separate: it is a self-contained concern with its
own tests, and `service.ts` is already the largest file in the state layer.

### `python/helpers/state.py`

One new op, alongside `state`, `lookup`, `followers`:

```python
if op == "avatars":
    return {"id": req_id, "ok": True,
            "data": {"avatars": self._avatars(req["streamers"])}}
```

`_avatars` calls `video_player_stream_info_overlay_channel(login)` per name
and reads `.user.profile_image_url`
(`Integration.py:370`, response type at
`.../response/VideoPlayerStreamInfoOverlayChannel.py`).

Error handling mirrors the existing `_state` method exactly:

- a per-name failure degrades that entry to `None` and the batch continues;
- an **auth** error breaks out and propagates, so a dead session is still
  reported honestly through the existing `code: "AUTH"` path rather than
  being silently swallowed into a roster of monograms.

Returns a `{login: url_or_null}` mapping.

### `apps/backend/src/state/service.ts`

`StreamerState` gains one field:

```ts
/** Twitch CDN profile image URL; null when unknown or the channel has none. */
avatarUrl: string | null;
```

populated in the existing `.map()` over the helper's response.

This field participates in the existing `JSON.stringify` change detection
(`service.ts`, `doRefresh`), which is correct and intended: an avatar
arriving emits exactly one SSE frame and is then stable. Because the cached
URL is a stable string and not a wall-clock value, it cannot cause the
spurious per-tick frames the "derived fields must be deterministic"
constraint guards against.

## Frontend

### `components/StreamerAvatar.tsx` *(new)*

Wraps Mantine 9's `Avatar`. Verified in the installed build
(`@mantine/core@9.6.0`, `Avatar.mjs:37,51,65`): it holds an `error` state
initialised from `!src`, resets it when `src` changes, and sets it from the
image's `onError`. So a null URL **and** a URL whose image 404s both fall
back to `children` — the monogram — with no extra code. `color="initials"`
derives a stable hue from `name` via the shipped `get-initials-color`
module, so a given streamer keeps the same colour without a hand-rolled
hash.

The component owns:

- **size**, per surface (40px on cards, 28px in config rows);
- **live/offline treatment**: a `--tw-live` ring when online; the offline
  dimming already applied by `.offline` on the card covers the rest;
- **`alt=""`**. The name is always adjacent, so the image is decorative and
  a screen reader must not announce it twice.

### Links

Avatar and name together form one anchor to `https://twitch.tv/<login>`,
`target="_blank"`, `rel="noopener noreferrer"`.

The href uses the **login**, never the display name. Display names may carry
non-ASCII characters (Japanese and Korean channels commonly do) and do not
resolve as URLs; the login is the canonical channel path.

### Surfaces

- **`components/StreamerCard.tsx`** — avatar to the left of the display name
  inside the existing header `Group`, 40px, live ring or offline dim.
- **`routes/Streamers.tsx`** — 28px avatar in each config row, name linked.
  These rows come from `/api/config`, which carries no `avatarUrl`, so the
  screen reads the live state for the URL and falls back to a monogram when
  the miner is stopped and no state exists. The config screen must remain
  fully usable with the miner down.

## Testing

Per-file `.test.ts` beside each module, matching existing convention.

**`state/avatars.test.ts`**
- a fresh row is served from cache with no helper request
- a missing login is fetched and persisted
- a `null` result is cached and *not* re-fetched on the next pass
- a row older than the TTL is re-fetched
- a helper rejection returns the cached entries and does not throw
- at most `MAX_FETCH_PER_PASS` lookups happen in one pass

**`python/tests/test_state.py`**
- the `avatars` op returns a login→URL mapping
- one failing name degrades to `null` without losing the rest of the batch
- an auth error propagates as `code: "AUTH"`

**`components/StreamerAvatar.test.tsx`**
- renders the image when a URL is present
- renders the monogram when the URL is null
- the same login yields the same colour across renders

**`StreamerCard.test.tsx` / `Streamers.test.tsx`**
- the link targets `twitch.tv/<login>` and carries `rel="noopener noreferrer"`
- the link uses the login even when the display name differs

## Out of scope

Explicitly not built, to keep the surface honest:

- no image proxy, no bytes cached on disk, no eviction policy
- no manual "refresh avatars" control
- no banner images, no channel descriptions
- no avatar in the events feed or the log view
