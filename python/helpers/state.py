"""Long-lived NDJSON server exposing structured miner state.

One request per stdin line, one response per stdout line. Reads go through
the miner's own GQL layer so persisted-query hashes stay upstream's problem.
"""
import json
import os
import re
import sys

import requests

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
                return {"id": req_id, "ok": True, "data": self._lookup(req["username"])}
            if op == "followers":
                return {"id": req_id, "ok": True,
                        "data": {"followers": self.session.gql.channel_follows()}}
            if op == "state":
                return {"id": req_id, "ok": True,
                        "data": {"streamers": self._state(req["streamers"])}}
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

    def _lookup(self, username: str) -> dict:
        response = self.session.gql.get_id_from_login(username)
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

    def _one(self, username: str) -> dict:
        context = self.session.gql.get_channel_points_context(username)
        community = getattr(context, "community", None)
        if community is None:
            return {"username": username, "channelId": None, "displayName": None,
                    "points": None, "isOnline": None, "pointsEnabled": None}
        channel = community.channel
        live = self.session.gql.with_is_stream_live_query(channel.id)
        return {
            "username": username,
            "channelId": channel.id,
            "displayName": community.display_name,
            "points": channel.edge.community_points.balance,
            "isOnline": live.user.stream is not None,
            "pointsEnabled": channel.community_points_settings.is_enabled,
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
    here = os.path.dirname(os.path.abspath(__file__))
    # `python/` for the helpers package, `vendor/miner` for the miner package.
    sys.path.insert(0, os.path.join(here, ".."))
    sys.path.insert(0, os.path.join(here, "..", "..", "vendor", "miner"))
    from helpers._session import build_session

    session = build_session(os.environ["TWITCH_USERNAME"],
                            os.environ.get("COOKIES_DIR", "cookies"))
    serve(Handler(session))


if __name__ == "__main__":
    main()
