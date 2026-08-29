import io
import json
from types import SimpleNamespace

import pytest
import requests

from TwitchChannelPointsMiner.classes.gql.Errors import RetryError

from helpers.state import Handler, serve


def points_response(balance, channel_id="42", enabled=True):
    return SimpleNamespace(
        community=SimpleNamespace(
            display_name="Alpha",
            channel=SimpleNamespace(
                id=channel_id,
                edge=SimpleNamespace(
                    community_points=SimpleNamespace(balance=balance)
                ),
                community_points_settings=SimpleNamespace(is_enabled=enabled),
            ),
        )
    )


class FakeGQL:
    def __init__(self, balances=None, live=None, follows=None):
        self.balances = balances or {}
        self.live = live or {}
        self.follows = follows or []

    def get_channel_points_context(self, username):
        if username not in self.balances:
            return SimpleNamespace(community=None)
        return points_response(self.balances[username])

    def with_is_stream_live_query(self, channel_id):
        stream = SimpleNamespace(id="s1") if self.live.get(channel_id) else None
        return SimpleNamespace(user=SimpleNamespace(id=channel_id, stream=stream))

    def get_id_from_login(self, username):
        return SimpleNamespace(id="42" if username == "alpha" else "")

    def channel_follows(self, limit=100, order=None):
        return self.follows


def handler(**kw):
    session = SimpleNamespace(
        gql=FakeGQL(**kw), reload_cookies=lambda: True, is_logged_in=lambda: True
    )
    return Handler(session)


def test_state_returns_exact_integer_balance():
    h = handler(balances={"alpha": 123456}, live={"42": True})
    out = h.handle({"id": 1, "op": "state", "streamers": ["alpha"]})
    assert out["ok"] is True
    assert out["data"]["streamers"][0] == {
        "username": "alpha",
        "channelId": "42",
        "displayName": "Alpha",
        "points": 123456,
        "isOnline": True,
        "pointsEnabled": True,
    }


def test_offline_streamer_reported_as_not_online():
    h = handler(balances={"alpha": 10}, live={"42": False})
    out = h.handle({"id": 1, "op": "state", "streamers": ["alpha"]})
    assert out["data"]["streamers"][0]["isOnline"] is False


def test_unknown_streamer_yields_null_points_not_zero():
    """Zero would be indistinguishable from a real empty balance."""
    h = handler(balances={})
    out = h.handle({"id": 1, "op": "state", "streamers": ["ghost"]})
    assert out["data"]["streamers"][0]["points"] is None


def test_one_failing_streamer_does_not_fail_the_whole_batch():
    class Exploding(FakeGQL):
        def get_channel_points_context(self, username):
            if username == "bad":
                raise RuntimeError("gql exploded")
            return super().get_channel_points_context(username)

    session = SimpleNamespace(
        gql=Exploding(balances={"alpha": 5}, live={"42": True}),
        reload_cookies=lambda: True,
        is_logged_in=lambda: True,
    )
    out = Handler(session).handle(
        {"id": 1, "op": "state", "streamers": ["alpha", "bad"]}
    )
    assert out["ok"] is True
    names = {s["username"]: s for s in out["data"]["streamers"]}
    assert names["alpha"]["points"] == 5
    assert names["bad"]["error"] == "gql exploded"


def test_lookup_resolves_a_real_username():
    h = handler()
    assert h.handle({"id": 1, "op": "lookup", "username": "alpha"})["data"] == {
        "username": "alpha",
        "channelId": "42",
        "exists": True,
    }


def test_lookup_reports_missing_username():
    h = handler()
    assert h.handle({"id": 1, "op": "lookup", "username": "nope"})["data"]["exists"] is False


def test_followers_returns_logins():
    h = handler(follows=["a", "b"])
    assert h.handle({"id": 1, "op": "followers"})["data"] == {"followers": ["a", "b"]}


def test_unknown_op_is_a_bad_request():
    out = handler().handle({"id": 7, "op": "nonsense"})
    assert out == {"id": 7, "ok": False, "error": "unknown op: nonsense",
                   "code": "BAD_REQUEST"}


def test_auth_failure_triggers_one_cookie_reload_then_reports_auth():
    reloads = []

    class AuthFail(FakeGQL):
        def get_channel_points_context(self, username):
            raise RuntimeError("401 Unauthorized")

    session = SimpleNamespace(
        gql=AuthFail(),
        reload_cookies=lambda: (reloads.append(1), True)[1],
        is_logged_in=lambda: False,
    )
    out = Handler(session).handle({"id": 1, "op": "state", "streamers": ["alpha"]})
    assert out["ok"] is False
    assert out["code"] == "AUTH"
    assert len(reloads) == 1


def test_serve_reads_and_writes_one_line_per_request():
    stdin = io.StringIO('{"id":1,"op":"ping"}\n{"id":2,"op":"ping"}\n')
    stdout = io.StringIO()
    serve(handler(), stdin, stdout)
    lines = [json.loads(x) for x in stdout.getvalue().strip().split("\n")]
    assert [l["id"] for l in lines] == [1, 2]
    assert all(l["ok"] for l in lines)


def test_serve_survives_a_malformed_line():
    stdin = io.StringIO('not json\n{"id":2,"op":"ping"}\n')
    stdout = io.StringIO()
    serve(handler(), stdin, stdout)
    lines = [json.loads(x) for x in stdout.getvalue().strip().split("\n")]
    assert lines[0]["ok"] is False
    assert lines[1]["id"] == 2


def _http_error(status_code):
    """A deliberately marker-free message: real proxies/CDNs in front of an
    API do not always echo the status code or the words "unauthorized" /
    "authentication" in the exception text. This is the actual gap a naive
    string match misses -- the only reliable signal is the structural
    `.response.status_code`, not any particular wording.
    """
    response = SimpleNamespace(status_code=status_code)
    return requests.exceptions.HTTPError(
        "Server responded with an error", response=response
    )


def _retry_error_wrapping(exc):
    """Mirrors how AttemptStrategy/__handle_result really build a RetryError:
    RetryError.errors is a list[ExceptionContext], and ExceptionContext.__repr__
    is `f"{self.exception}"` when there's no stack trace (see
    vendor/miner/TwitchChannelPointsMiner/utils/AttemptStrategy.py). We don't
    import ExceptionContext (it's not part of our pinned seam) so we fake the
    same repr behaviour with a minimal stand-in.
    """
    class FakeExceptionContext:
        def __init__(self, exception):
            self.exception = exception

        def __repr__(self):
            return f"{self.exception}"

    return RetryError("SomeOperation", [FakeExceptionContext(exc)])


def test_retry_error_wrapped_401_is_classified_auth():
    """The miner never lets a raw requests.HTTPError escape post_gql_request_single
    -- it always retries and wraps failures in RetryError (see
    Integration.py __handle_result). A real expired-cookie 401 therefore reaches
    us as a RetryError whose nested errors wrap an HTTPError. The HTTPError's
    message text is deliberately marker-free here (see _http_error) so this
    test actually exercises the structural status_code check, not the string
    fallback -- a naive str(exc).lower() match would miss this case, which is
    exactly the defect being fixed. Must be classified AUTH, not GQL, or the
    backend never surfaces LOGIN_REQUIRED on a real expired token."""
    reloads = []

    class AuthFail(FakeGQL):
        def get_channel_points_context(self, username):
            raise _retry_error_wrapping(_http_error(401))

    session = SimpleNamespace(
        gql=AuthFail(),
        reload_cookies=lambda: (reloads.append(1), True)[1],
        is_logged_in=lambda: False,
    )
    out = Handler(session).handle({"id": 1, "op": "state", "streamers": ["alpha"]})
    assert out["ok"] is False
    assert out["code"] == "AUTH"
    assert len(reloads) == 1


def test_genuine_non_auth_gql_failure_stays_gql_and_does_not_reload_cookies():
    """Guards against over-matching: a RetryError with no auth-shaped nested
    error must not be misclassified as AUTH, which would trigger a spurious
    cookie reload / re-login.

    Uses `lookup`, not `state`: a `state` batch already swallows per-streamer
    non-auth errors into an `error` field on that streamer (see
    test_one_failing_streamer_does_not_fail_the_whole_batch) rather than
    surfacing top-level `ok: False`, so it can't distinguish GQL from AUTH at
    the `handle()` level. `lookup` has no such per-item catch, so a raised
    exception reaches `handle()`'s own except block directly.
    """
    reloads = []

    class NonAuthFail(FakeGQL):
        def get_id_from_login(self, username):
            raise _retry_error_wrapping(RuntimeError("connection reset by peer"))

    session = SimpleNamespace(
        gql=NonAuthFail(),
        reload_cookies=lambda: (reloads.append(1), True)[1],
        is_logged_in=lambda: True,
    )
    out = Handler(session).handle({"id": 1, "op": "lookup", "username": "alpha"})
    assert out["ok"] is False
    assert out["code"] == "GQL"
    assert len(reloads) == 0


def _fails_with(exc_factory):
    """Builds a fake GQL whose get_id_from_login raises the given exception.
    Uses `lookup`, not `state`, for the same reason as
    test_genuine_non_auth_gql_failure_stays_gql_and_does_not_reload_cookies:
    a `state` batch swallows non-auth per-streamer errors instead of
    surfacing a top-level code, so it can't distinguish GQL from AUTH here.
    """
    class Failing(FakeGQL):
        def get_id_from_login(self, username):
            raise exc_factory()

    return Failing()


def test_timeout_with_401_as_a_substring_of_a_larger_number_is_not_auth():
    """Regression guard for a real false positive: a bare '401'/'403'
    substring match previously classified this as AUTH because '401' is a
    substring of '40100'. A spurious logout from a timeout message is just
    as damaging as never detecting a real auth failure."""
    reloads = []
    session = SimpleNamespace(
        gql=_fails_with(lambda: TimeoutError("Connection timed out after 40100ms")),
        reload_cookies=lambda: (reloads.append(1), True)[1],
        is_logged_in=lambda: True,
    )
    out = Handler(session).handle({"id": 1, "op": "lookup", "username": "alpha"})
    assert out["ok"] is False
    assert out["code"] == "GQL"
    assert len(reloads) == 0


def test_request_id_containing_401_is_not_auth():
    """Regression guard: a Twitch request id like '8401f' must not trip
    auth detection just because it contains the digits '401'."""
    reloads = []
    session = SimpleNamespace(
        gql=_fails_with(lambda: RuntimeError("server error, request id 8401f")),
        reload_cookies=lambda: (reloads.append(1), True)[1],
        is_logged_in=lambda: True,
    )
    out = Handler(session).handle({"id": 1, "op": "lookup", "username": "alpha"})
    assert out["ok"] is False
    assert out["code"] == "GQL"
    assert len(reloads) == 0


def test_rate_limit_retry_after_403_parameter_is_not_auth():
    """Regression guard for the tricky case: 'retry-after=403' is a
    rate-limit parameter value, not an HTTP status code, even though a
    bare word-boundary regex (\\b(401|403)\\b) alone would still match it
    -- '=' counts as a non-word boundary. We explicitly exclude a status
    code immediately preceded by '=' to rule this out. See
    _text_looks_like_auth's docstring for the full rationale."""
    reloads = []
    session = SimpleNamespace(
        gql=_fails_with(lambda: RuntimeError("rate limited: retry-after=403")),
        reload_cookies=lambda: (reloads.append(1), True)[1],
        is_logged_in=lambda: True,
    )
    out = Handler(session).handle({"id": 1, "op": "lookup", "username": "alpha"})
    assert out["ok"] is False
    assert out["code"] == "GQL"
    assert len(reloads) == 0


def test_genuine_401_client_error_text_still_classifies_as_auth():
    """Regression guard for the fix made in round 1: a plain exception
    (not wrapped in a RetryError/GQLError, and not a requests.HTTPError
    with a structured status_code -- i.e. only the text fallback can catch
    it) whose message is a genuine '401 Client Error: Unauthorized' must
    still classify as AUTH. This is exactly the shape
    test_auth_failure_triggers_one_cookie_reload_then_reports_auth already
    pins for 'state', repeated here through 'lookup' for symmetry with the
    other text-fallback tests in this file."""
    reloads = []
    session = SimpleNamespace(
        gql=_fails_with(lambda: RuntimeError(
            "401 Client Error: Unauthorized for url: https://gql.twitch.tv/gql"
        )),
        reload_cookies=lambda: (reloads.append(1), True)[1],
        is_logged_in=lambda: False,
    )
    out = Handler(session).handle({"id": 1, "op": "lookup", "username": "alpha"})
    assert out["ok"] is False
    assert out["code"] == "AUTH"
    assert len(reloads) == 1
