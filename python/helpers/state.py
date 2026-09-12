"""Long-lived NDJSON server exposing structured miner state.

One request per stdin line, one response per stdout line. Reads go through
the miner's own GQL layer so persisted-query hashes stay upstream's problem.
"""
import json
import os
import re
import sys

# `python/` for the helpers package, `vendor/miner` for the miner package.
# These must run at import time, not inside main(): production spawns this
# file as a script (`python <pythonDir>/helpers/state.py`, see
# apps/backend/src/index.ts), where sys.path[0] is `python/helpers/` and
# neither package is importable -- so the module-level imports below would
# fail before main() ever ran. run.py hoists the same way (run.py:12);
# helpers/login.py can keep its inserts in main() only because every one of
# its module-level imports is stdlib. The pytest suite hides the difference:
# pyproject.toml's `pythonpath` puts both on sys.path before the tests
# import anything, so state.py imported cleanly while being unrunnable.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, ".."))
sys.path.insert(0, os.path.join(_HERE, "..", "..", "vendor", "miner"))

import requests

from TwitchChannelPointsMiner.JsonParser import InvalidJsonShapeError
from TwitchChannelPointsMiner.classes.gql.Errors import GQLError

# Word-boundary match for a bare status code, e.g. "401 Client Error" or
# "HTTP 403" -- but NOT "40100ms" or "8401f" (word boundaries require a
# transition into/out of a run of digits, and "40100"/"8401f" never have
# a non-digit/non-word character directly touching "401"/"403" at the
# right spot). Deliberately excludes a status code immediately preceded
# by "=" (e.g. "retry-after=403") -- see docstring on
# _text_looks_like_auth for why.
_STATUS_RE = re.compile(r"(?<!=)\b(401|403)\b")
_WORD_MARKERS = ("unauthorized", "authentication")


def _text_looks_like_auth(text: str) -> bool:
    """Last-resort text fallback -- the structural HTTPError/status_code
    check is the reliable path (see _is_http_auth_error) and always runs
    first. This fallback exists only for exceptions that never carry a
    structured status code at all (e.g. a plain RuntimeError from a fake,
    or a genuinely worded but non-HTTPError failure).

    A bare substring match on "401"/"403" is dangerously loose: it also
    matches inside "40100ms", "8401f" (a request id), or
    "retry-after=403" (a rate-limit parameter value, not a status code).
    A false positive here causes a spurious logout, which is exactly as
    damaging as never detecting a real auth failure -- so this errs
    conservative rather than broad:
      - the status code must sit on a word boundary (rules out "40100",
        "8401f"), AND
      - must not be immediately preceded by "=" (rules out
        "retry-after=403", which `\\b` alone does not exclude since "="
        counts as a non-word boundary too).
    This means some exotic phrasings (e.g. "code=401") will be missed by
    the fallback and fall through to `code: "GQL"` -- an acceptable
    false negative, since the structural check remains the primary,
    reliable path for anything that's actually an HTTPError.
    """
    lowered = text.lower()
    if _STATUS_RE.search(lowered):
        return True
    return any(marker in lowered for marker in _WORD_MARKERS)


def _is_http_auth_error(exc) -> bool:
    """Exact: an HTTP 401/403 from the transport layer."""
    if isinstance(exc, requests.exceptions.HTTPError):
        response = getattr(exc, "response", None)
        if response is not None and response.status_code in (401, 403):
            return True
    return False


def _is_auth_error(exc: Exception) -> bool:
    if _is_http_auth_error(exc):
        return True
    # The miner wraps failures (post_gql_request_single retries and re-raises
    # as RetryError/GQLResponseErrors); a 401 can be buried in the nested
    # error list rather than in this exception's own str(). RetryError wraps
    # each attempt's failure in an AttemptStrategy.ExceptionContext, whose
    # `.exception` holds the real underlying exception (e.g. the HTTPError
    # itself) -- so the exact status_code check must recurse into that, not
    # just re-run the text fallback on its repr(). See
    # vendor/miner/.../classes/gql/Errors.py and utils/AttemptStrategy.py.
    if isinstance(exc, GQLError):
        nested = getattr(exc, "errors", None) or []
        for item in nested:
            inner = getattr(item, "exception", item)
            if _is_http_auth_error(inner):
                return True
            if _text_looks_like_auth(repr(item)):
                return True
    return _text_looks_like_auth(str(exc))


def _is_missing_user_error(exc: Exception) -> bool:
    """True for the GQL failure that means "this login has no Twitch user".

    `GetIDFromLogin` parses `data.user` with expect_dict; Twitch returns
    `data.user: null` for an unknown login, so the failure arrives as a
    RetryError wrapping an InvalidJsonShapeError whose `path` is
    ["user", "data"] (JsonParentContext appends parents innermost-first).
    Checked on that structured path, not on str(exc), so an unrelated parse
    failure elsewhere in the response is still reported as a real error.
    """
    for item in getattr(exc, "errors", None) or []:
        inner = getattr(item, "exception", item)
        if isinstance(inner, InvalidJsonShapeError) and list(inner.path)[:2] == [
            "user", "data",
        ]:
            return True
    return False


def _multiplier(points) -> float | None:
    """The combined factor of every active channel-points multiplier.

    None rather than 1.0 when there is none: 1.0 reads as "a neutral
    multiplier is active", and the card needs to tell "no multiplier"
    from "a multiplier that happens to be 1x" to decide whether to show
    the badge at all.

    Deliberately NOT reported as a subscription flag. Upstream's
    is_subscribed() is exactly this "has any multiplier" test, but
    multipliers have other sources, so a boolean called `subscribed`
    would be an inference we cannot back up.
    """
    factors = getattr(points, "active_multipliers", None) or []
    total = sum(f.factor for f in factors)
    return round(total, 2) if total else None


def _goal(settings) -> dict | None:
    """The one community goal worth showing, or None.

    Filtered to goals a viewer can still contribute to -- an ended or
    out-of-stock goal would render a dead progress bar. Where a channel
    runs several, the least complete is chosen: it is the one with the
    most room left to contribute to.
    """
    goals = getattr(settings, "goals", None) or []
    live = [
        g for g in goals
        if getattr(g, "status", None) == "STARTED"
        and getattr(g, "is_in_stock", False)
        and getattr(g, "amount_needed", 0) > 0
    ]
    if not live:
        return None
    pick = min(live, key=lambda g: g.points_contributed / g.amount_needed)
    return {
        "title": pick.title,
        "contributed": pick.points_contributed,
        "needed": pick.amount_needed,
    }

_EMPTY_PROFILE = {"avatarUrl": None, "game": None, "title": None, "viewers": None}


def _profile(user) -> dict:
    """Flatten one VideoPlayerStreamInfoOverlayChannel user into a row.

    Every field is read with getattr: a miner build whose parser predates
    broadcastSettings must still yield an avatar rather than failing the
    whole profile batch.

    `viewers` is None rather than 0 when the channel is offline. Zero is
    a claim that a running stream has nobody watching it, which is a
    different fact from there being no stream at all.
    """
    settings = getattr(user, "broadcast_settings", None)
    game = getattr(settings, "game", None) if settings is not None else None
    stream = getattr(user, "stream", None)
    return {
        "avatarUrl": getattr(user, "profile_image_url", None) or None,
        "game": getattr(game, "display_name", None) if game is not None else None,
        "title": getattr(settings, "title", None) if settings is not None else None,
        "viewers": (
            getattr(stream, "viewers_count", None) if stream is not None else None
        ),
    }

def _next_drop(campaign_ids: list, campaigns: dict) -> dict | None:
    """The nearest unclaimed drop across a channel's campaigns.

    A campaign ladders its drops -- 30, 60, 120 minutes -- so "the drop"
    for a channel is the next one still to earn. Ordered by minutes
    required so the answer is the one worth waiting for rather than
    whichever the API happened to list first.

    A drop is skipped once claimed: it is no longer something the viewer
    can earn, and reporting it would put a finished bar on the card.
    `claimable` marks the other end -- the minutes are met and Twitch has
    minted an instance id, so it is sitting there to be collected.

    None when the channel has no campaign, or every drop in it is done.
    """
    remaining = []
    for cid in campaign_ids:
        campaign = campaigns.get(cid)
        if campaign is None:
            continue
        for drop in getattr(campaign, "time_based_drops", None) or []:
            edge = getattr(drop, "self_edge", None)
            if edge is None or getattr(edge, "is_claimed", False):
                continue
            required = getattr(drop, "required_minutes_watched", 0) or 0
            if required <= 0:
                continue
            remaining.append((required, drop, edge))

    if not remaining:
        return None
    required, drop, edge = min(remaining, key=lambda r: r[0])
    watched = getattr(edge, "current_minutes_watched", 0) or 0
    end_at = getattr(drop, "end_at", None)
    return {
        "name": getattr(drop, "name", None) or "Drop",
        # Clamped: Twitch keeps counting past the requirement, and a bar
        # reporting 71/60 reads as a bug rather than a finished drop.
        "minutes": min(watched, required),
        "required": required,
        "claimable": getattr(edge, "drop_instance_id", None) is not None,
        # What the drop actually awards. Twitch lists one edge per benefit
        # instance, so a drop granting two of an item repeats the name --
        # deduped while keeping order, since "Crate, Crate" reads as a bug.
        "benefits": list(dict.fromkeys(getattr(drop, "benefits", None) or [])),
        # Epoch ms: end_at is a timezone-aware datetime from upstream's
        # expect_iso_8601, and datetime is not JSON serialisable, so it
        # would raise in serve()'s json.dumps if passed through.
        "endsAt": (
            int(end_at.timestamp() * 1000) if end_at is not None else None
        ),
    }

class Handler:
    def __init__(self, session):
        self.session = session

    def handle(self, req: dict) -> dict:
        req_id = req.get("id")
        op = req.get("op")
        try:
            if op == "ping":
                return {"id": req_id, "ok": True, "data": {"pong": True}}
            if op == "check_login":
                return {"id": req_id, "ok": True,
                        "data": {"loggedIn": self.session.is_logged_in()}}
            if op == "lookup":
                self._ensure_token()
                return {"id": req_id, "ok": True, "data": self._lookup(req["username"])}
            if op == "followers":
                # Unconditional, unlike _ensure_token() below: `followers`
                # is a user-initiated action where the pickle may well have
                # been rewritten since the last poll, and one extra file
                # read is free next to the GQL round trip that follows.
                self.session.reload_cookies()
                return {"id": req_id, "ok": True,
                        "data": {"followers": self.session.gql.channel_follows()}}
            if op == "state":
                self._ensure_token()
                return {"id": req_id, "ok": True,
                        "data": {"streamers": self._state(req["streamers"])}}
            if op == "profiles":
                self._ensure_token()
                return {"id": req_id, "ok": True,
                        "data": {"profiles": self._profiles(req["streamers"])}}
            if op == "drops":
                self._ensure_token()
                return {"id": req_id, "ok": True,
                        "data": {"drops": self._drops(req["streamers"])}}
            return {"id": req_id, "ok": False, "error": f"unknown op: {op}",
                    "code": "BAD_REQUEST"}
        except KeyError as exc:
            return {"id": req_id, "ok": False, "error": f"missing field: {exc}",
                    "code": "BAD_REQUEST"}
        except Exception as exc:
            if _is_auth_error(exc):
                self.session.reload_cookies()
                if not self.session.is_logged_in():
                    return {"id": req_id, "ok": False, "error": str(exc),
                            "code": "AUTH"}
            return {"id": req_id, "ok": False, "error": str(exc), "code": "GQL"}

    def _ensure_token(self) -> None:
        """Loads the cookie pickle when the session is holding no token.

        build_session() leaves the session tokenless, and the GQL ops below
        reach Twitch without going through is_logged_in(). That was harmless
        while the only tokenless helper was one spawned before the very
        first login -- but logging out of Twitch deletes the pickle and
        recycles the helper, so its replacement now routinely starts
        tokenless while the user is midway through signing back in. The
        login writes a good pickle, and without this nothing on these paths
        ever re-read it: every request sent `Authorization: OAuth None` and
        took a 401 through all three retries, permanently.

        Guarded on the token rather than called unconditionally so the
        steady state stays one GQL round trip per poll instead of a pickle
        read every 60 seconds. A token that is present but *expired* is a
        different failure and still handled where it always was -- by the
        AUTH classification in handle()'s except block.
        """
        if getattr(self.session, "login", None) is None:
            return
        if self.session.login.get_auth_token() is None:
            self.session.reload_cookies()

    def _lookup(self, username: str) -> dict:
        try:
            response = self.session.gql.get_id_from_login(username)
        except GQLError as exc:
            # "No such user" is a normal answer here, not a failure, but
            # upstream cannot express it: get_id_from_login's docstring
            # promises "an empty string if the user doesn't exist", while the
            # parser it delegates to runs expect_dict over `data.user`. Twitch
            # answers `data.user: null` for an unknown login, so the parse
            # raises InvalidJsonShapeError and post_gql_request_single rethrows
            # it as RetryError. Reporting that as an error puts "Internal
            # Server Error" in front of anyone who fumbles a username.
            #
            # Matched structurally on the parse path rather than on message
            # text so a real outage still surfaces as an error: only a
            # null/absent `data.user` means the user does not exist. Anything
            # else (network reset, 5xx, an auth failure) propagates to
            # handle(), which keeps its AUTH/GQL classification.
            if not _is_missing_user_error(exc):
                raise
            return {"username": username, "channelId": "", "exists": False}
        channel_id = getattr(response, "id", "") or ""
        return {"username": username, "channelId": channel_id,
                "exists": bool(channel_id)}

    def _state(self, usernames: list[str]) -> list[dict]:
        out = []
        auth_error = None
        for username in usernames:
            try:
                out.append(self._one(username))
            except Exception as exc:
                if _is_auth_error(exc):
                    auth_error = exc
                    break
                out.append({"username": username, "points": None, "isOnline": None,
                            "error": str(exc)})
        if auth_error is not None:
            raise auth_error
        return out

    def _profiles(self, usernames: list[str]) -> dict:
        """Avatar, category, stream title and viewer count per login.

        All four come off ONE GQL call. This started as an avatar-only
        lookup, but the response it was already making carries the
        broadcast settings and the running stream too, so the category
        and viewer count cost nothing beyond what the avatar refresh
        already spent.

        Shaped like _state's loop for the same reason: one unreachable
        channel must not cost the whole batch, but an auth failure is
        about the session rather than the channel and has to reach
        handle() so it can be reported as AUTH. Degrading that to a null
        avatar would leave a signed-out user staring at monograms with no
        prompt to sign in again.
        """
        out = {}
        auth_error = None
        for username in usernames:
            try:
                response = self.session.gql.video_player_stream_info_overlay_channel(
                    username
                )
                out[username] = _profile(response.user)
            except Exception as exc:
                if _is_auth_error(exc):
                    auth_error = exc
                    break
                out[username] = _EMPTY_PROFILE.copy()
        if auth_error is not None:
            raise auth_error
        return out

    def _drops(self, streamers: dict) -> dict:
        """The next unclaimed drop per channel, or None where there is none.

        Three GQL calls stitched together, because no single one answers
        the question:

          - get_available_drops(channel_id) gives the campaign ids this
            channel is currently running -- ids only, no names, no
            progress. Per channel, so it is the expensive half.
          - get_inventory() gives progress for every campaign we have
            started, across all channels. Global, so it is fetched ONCE
            for the whole batch rather than per streamer.

        The inventory is global, which is the trap here: it holds
        campaigns for channels we are not asking about. Only ids the
        channel itself reported may be attributed to it, or a drop
        earned elsewhere would show up on the wrong card.

        `streamers` maps login -> channel id, since the available-drops
        query is keyed by channel id while everything the caller holds
        is keyed by login.
        """
        out = {}
        # Fetched before the loop: one global call, not one per channel.
        # An auth failure here is about the session and must propagate.
        inventory = self.session.gql.get_inventory()
        campaigns = {
            c.id: c for c in (getattr(inventory, "campaigns", None) or [])
        }

        auth_error = None
        for login, channel_id in streamers.items():
            try:
                ids = getattr(
                    self.session.gql.get_available_drops(channel_id), "ids", None
                ) or []
                out[login] = _next_drop(ids, campaigns)
            except Exception as exc:
                if _is_auth_error(exc):
                    auth_error = exc
                    break
                # One unreachable channel must not cost the whole batch --
                # the same contract as _state and _profiles.
                out[login] = None
        if auth_error is not None:
            raise auth_error
        return out

    def _one(self, username: str) -> dict:
        context = self.session.gql.get_channel_points_context(username)
        community = getattr(context, "community", None)
        if community is None:
            return {"username": username, "channelId": None, "displayName": None,
                    "points": None, "isOnline": None, "pointsEnabled": None,
                    "streamId": None, "streamStartedAt": None,
                    "multiplier": None, "claimPending": False, "goal": None}
        channel = community.channel
        live = self.session.gql.with_is_stream_live_query(channel.id)
        stream = live.user.stream
        points = channel.edge.community_points
        return {
            "username": username,
            "channelId": channel.id,
            "displayName": community.display_name,
            "points": channel.edge.community_points.balance,
            "isOnline": stream is not None,
            "pointsEnabled": channel.community_points_settings.is_enabled,
            # Twitch's own stream identity and start time. This query
            # already returned both and we reduced the whole response to a
            # boolean; the start time is authoritative in a way an
            # observed transition is not, since it is right the first time
            # we look at a stream already in progress.
            #
            # created_at arrives as a timezone-aware datetime (upstream
            # parses the Z-suffixed UTC string with expect_iso_8601), so
            # .timestamp() is unambiguous. It is converted here rather
            # than passed through because datetime is not JSON
            # serialisable and would raise in serve()'s json.dumps.
            "streamId": stream.id if stream is not None else None,
            "streamStartedAt": (
                int(stream.created_at.timestamp() * 1000)
                if stream is not None
                else None
            ),
            # All three ride the response this method already fetched --
            # no extra GQL call. Every one is read with getattr so a miner
            # build whose parser predates the field degrades to a card
            # without the badge instead of failing the whole state poll.
            "multiplier": _multiplier(points),
            "claimPending": getattr(points, "available_claim", None) is not None,
            "goal": _goal(channel.community_points_settings),
        }


def serve(handler: Handler, stdin=sys.stdin, stdout=sys.stdout) -> None:
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            response = {"id": None, "ok": False, "error": f"bad json: {exc}",
                        "code": "BAD_REQUEST"}
        else:
            response = handler.handle(req)
        stdout.write(json.dumps(response) + "\n")
        stdout.flush()


def main() -> None:
    # Imported here rather than at module scope so that importing this
    # module (the unit tests do) does not build a Twitch client session.
    from helpers._session import build_session

    session = build_session(os.environ["TWITCH_USERNAME"],
                            os.environ.get("COOKIES_DIR", "cookies"))
    serve(Handler(session))


if __name__ == "__main__":
    main()
