import datetime
import io
import json
import os
import pathlib
import subprocess
import sys
from types import SimpleNamespace

import pytest
import requests

from TwitchChannelPointsMiner.JsonParser import InvalidJsonShapeError
from TwitchChannelPointsMiner.classes.gql.Errors import RetryError

from helpers.state import Handler, serve


def points_response(balance, channel_id="42", enabled=True, multipliers=(),
                    claim=None, goals=()):
    """Mirrors the shape upstream's parser produces.

    multipliers/available_claim/goals are all on the response _one already
    fetches -- see Parser.community_points_parser -- so the fixture has to
    carry them for the handler to be tested against anything real.
    """
    return SimpleNamespace(
        community=SimpleNamespace(
            display_name="Alpha",
            channel=SimpleNamespace(
                id=channel_id,
                edge=SimpleNamespace(
                    community_points=SimpleNamespace(
                        balance=balance,
                        active_multipliers=[
                            SimpleNamespace(factor=f) for f in multipliers
                        ],
                        available_claim=(
                            SimpleNamespace(id=claim) if claim is not None else None
                        ),
                    )
                ),
                community_points_settings=SimpleNamespace(
                    is_enabled=enabled, goals=list(goals)
                ),
            ),
        )
    )


def goal(title="New emotes", contributed=3000, needed=10000, status="STARTED",
         in_stock=True):
    return SimpleNamespace(
        title=title,
        points_contributed=contributed,
        amount_needed=needed,
        status=status,
        is_in_stock=in_stock,
    )


class FakeGQL:
    def __init__(self, balances=None, live=None, follows=None, avatars=None,
                 stream_id="s1", started_at=None):
        self.balances = balances or {}
        self.live = live or {}
        self.follows = follows or []
        self.avatars = avatars or {}
        self.stream_id = stream_id
        self.started_at = started_at or datetime.datetime(
            2026, 9, 6, 8, 15, tzinfo=datetime.timezone.utc
        )

    def video_player_stream_info_overlay_channel(self, username):
        value = self.avatars.get(username)
        if isinstance(value, Exception):
            raise value
        return SimpleNamespace(user=SimpleNamespace(profile_image_url=value))

    def get_channel_points_context(self, username):
        if username not in self.balances:
            return SimpleNamespace(community=None)
        return points_response(self.balances[username])

    def with_is_stream_live_query(self, channel_id):
        # created_at is what upstream's parser produces: a timezone-aware
        # datetime, not a string. state.py must convert it, since datetime
        # is not JSON serialisable.
        stream = (
            SimpleNamespace(id=self.stream_id, created_at=self.started_at)
            if self.live.get(channel_id)
            else None
        )
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
        "streamId": "s1",
        "streamStartedAt": 1788682500000,
        "multiplier": None,
        "claimPending": False,
        "goal": None,
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


def test_followers_loads_cookies_before_calling_gql():
    """build_session() leaves the session tokenless until reload_cookies()
    runs, and `followers` is the only op that reaches GQL without first
    going through is_logged_in(). Without an explicit reload it sent
    `Authorization: OAuth None` and Twitch answered 401 three times over.
    """
    calls = []

    class NeedsCookies:
        """Mirrors TwitchLogin: no token until the pickle is loaded."""

        def __init__(self):
            self.loaded = False

        def channel_follows(self, limit=100, order=None):
            calls.append("channel_follows")
            if not self.loaded:
                raise AssertionError("channel_follows called before reload_cookies")
            return ["a", "b"]

    gql = NeedsCookies()

    def reload():
        calls.append("reload_cookies")
        gql.loaded = True
        return True

    session = SimpleNamespace(gql=gql, reload_cookies=reload,
                              is_logged_in=lambda: True)
    out = Handler(session).handle({"id": 1, "op": "followers"})

    assert out["ok"] is True
    assert out["data"] == {"followers": ["a", "b"]}
    assert calls == ["reload_cookies", "channel_follows"]


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


# --- Runnable as a script ----------------------------------------------
# Production spawns this helper as `python <pythonDir>/helpers/state.py`
# (apps/backend/src/index.ts), where sys.path[0] is `python/helpers/` and
# neither the `helpers` package nor the vendored miner is importable. The
# rest of this file exercises state.py as an *import*, which pytest makes
# work via `pythonpath` in pyproject.toml -- a crutch production does not
# have. These tests deliberately run it the way production does, with
# PYTHONPATH cleared, so the import-time path setup cannot regress
# unnoticed again.

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE_SCRIPT = REPO_ROOT / "python" / "helpers" / "state.py"


def _run_as_script(script, stdin_text, tmp_path):
    env = dict(os.environ)
    # Both spellings: pytest's `pythonpath` ini setting never reaches a
    # child, but an inherited PYTHONPATH from the shell would, and would
    # silently restore the crutch this test exists to remove.
    env.pop("PYTHONPATH", None)
    env["PYTHONPATH"] = ""
    env["TWITCH_USERNAME"] = "alex"
    env["COOKIES_DIR"] = str(tmp_path / "cookies")
    return subprocess.run(
        [sys.executable, str(script)],
        input=stdin_text,
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(tmp_path),
        env=env,
    )


def test_state_py_runs_as_a_script_without_pythonpath(tmp_path):
    """The exact invocation index.ts uses. Fails with ModuleNotFoundError
    if the sys.path setup is left inside main()."""
    proc = _run_as_script(STATE_SCRIPT, '{"id": 1, "op": "ping"}\n', tmp_path)
    assert proc.returncode == 0, f"stderr:\n{proc.stderr}"
    assert json.loads(proc.stdout.strip()) == {
        "id": 1, "ok": True, "data": {"pong": True}
    }


def test_state_py_script_imports_the_vendored_miner(tmp_path):
    """Pins the specific failure: the module-level
    `from TwitchChannelPointsMiner...` import at the top of state.py must
    resolve without help from the environment."""
    proc = _run_as_script(STATE_SCRIPT, "", tmp_path)
    assert "ModuleNotFoundError" not in proc.stderr
    assert "TwitchChannelPointsMiner" not in proc.stderr
    assert proc.returncode == 0, f"stderr:\n{proc.stderr}"


# --- Regression: a nonexistent username is a normal answer, not an error ---


def test_lookup_reports_a_nonexistent_user_when_gql_raises_retry_error():
    """Regression guard for "Internal Server Error" when adding a streamer
    whose name is not a real Twitch user.

    `FakeGQL.get_id_from_login` returns `id=""` for an unknown user, which
    matches `GQL.get_id_from_login`'s docstring ("The id or an empty string
    if the user doesn't exist") but NOT its behaviour: the real parser runs
    `parse_expected_value(data, "user", expect_dict)`, and Twitch answers
    `data.user = null` for an unknown login, so the parse raises
    InvalidJsonShapeError -> RetryError. That must read as
    `exists: False`, not a 500.
    """
    class MissingUser(FakeGQL):
        def get_id_from_login(self, username):
            raise _retry_error_wrapping(
                # Exact shape observed against real Twitch: JsonParentContext
                # appends parents innermost-first, so path is ["user", "data"].
                InvalidJsonShapeError(["user", "data"], "dict expected, got None")
            )

    session = SimpleNamespace(
        gql=MissingUser(), reload_cookies=lambda: True, is_logged_in=lambda: True
    )
    out = Handler(session).handle({"id": 1, "op": "lookup", "username": "nope"})
    assert out["ok"] is True
    assert out["data"] == {"username": "nope", "channelId": "", "exists": False}


def test_lookup_still_reports_a_real_gql_failure_as_an_error():
    """Guards the other side of the fix above: swallowing every RetryError
    into `exists: False` would tell the user "No such Twitch user" when the
    truth is that the network or Twitch is down. Only a missing-user shaped
    parse failure may become `exists: False`.
    """
    session = SimpleNamespace(
        gql=_fails_with(
            lambda: _retry_error_wrapping(RuntimeError("connection reset by peer"))
        ),
        reload_cookies=lambda: True,
        is_logged_in=lambda: True,
    )
    out = Handler(session).handle({"id": 1, "op": "lookup", "username": "alpha"})
    assert out["ok"] is False
    assert out["code"] == "GQL"


def test_avatars_returns_a_login_to_url_mapping():
    h = handler(avatars={"alpha": "https://cdn/a.png", "beta": "https://cdn/b.png"})
    out = h.handle({"id": 1, "op": "avatars", "streamers": ["alpha", "beta"]})
    assert out["ok"] is True
    assert out["data"]["avatars"] == {
        "alpha": "https://cdn/a.png",
        "beta": "https://cdn/b.png",
    }


def test_avatars_reports_none_for_a_channel_without_one():
    h = handler(avatars={"alpha": None})
    out = h.handle({"id": 1, "op": "avatars", "streamers": ["alpha"]})
    assert out["data"]["avatars"] == {"alpha": None}


def test_one_failing_name_does_not_lose_the_rest_of_the_batch():
    h = handler(avatars={
        "alpha": RuntimeError("channel is gone"),
        "beta": "https://cdn/b.png",
    })
    out = h.handle({"id": 1, "op": "avatars", "streamers": ["alpha", "beta"]})
    assert out["ok"] is True
    assert out["data"]["avatars"] == {"alpha": None, "beta": "https://cdn/b.png"}


def test_auth_failure_propagates_rather_than_degrading_to_null():
    # A dead session must be reported, not quietly rendered as a roster of
    # monograms -- the user needs the sign-in prompt.
    response = requests.Response()
    response.status_code = 401
    h = handler(avatars={
        "alpha": requests.exceptions.HTTPError(response=response),
    })
    h.session.is_logged_in = lambda: False
    out = h.handle({"id": 1, "op": "avatars", "streamers": ["alpha"]})
    assert out["ok"] is False
    assert out["code"] == "AUTH"


def test_avatars_requires_the_streamers_field():
    h = handler()
    out = h.handle({"id": 1, "op": "avatars"})
    assert out["ok"] is False
    assert out["code"] == "BAD_REQUEST"


def test_one_reports_stream_identity_and_start():
    """The live query already carries the stream's id and createdAt.

    Twitch's own start time beats deriving one from observed transitions:
    it is correct the first time we look at a stream already running.
    """
    h = handler(
        balances={"alpha": 10},
        live={"42": True},
        stream_id="STREAM-1",
        started_at=datetime.datetime(2026, 9, 6, 8, 15, tzinfo=datetime.timezone.utc),
    )
    out = h._one("alpha")
    assert out["streamId"] == "STREAM-1"
    assert out["streamStartedAt"] == 1788682500000
    assert out["isOnline"] is True


def test_one_reports_nulls_when_offline():
    h = handler(balances={"alpha": 10}, live={"42": False})
    out = h._one("alpha")
    assert out["streamId"] is None
    assert out["streamStartedAt"] is None
    assert out["isOnline"] is False


def test_stream_start_is_json_serialisable():
    """A datetime here would raise when serve() writes the response."""
    h = handler(balances={"alpha": 10}, live={"42": True})
    json.dumps(h.handle({"id": 1, "op": "state", "streamers": ["alpha"]}))


def test_unknown_channel_returns_the_same_keys():
    """Every path through _one must agree on its shape."""
    h = handler(balances={})
    out = h._one("ghost")
    assert out["streamId"] is None
    assert out["streamStartedAt"] is None


def test_state_loads_cookies_when_the_session_has_no_token():
    """A helper spawned while no cookie pickle existed holds no token, and
    `state` reaches GQL without going through is_logged_in() -- so it sent
    `Authorization: OAuth None` and took a 401 on every attempt, forever.

    This became reachable when logging out of Twitch was added: logout
    deletes the pickle and recycles the helper, so the replacement spawns
    tokenless. The later login writes a perfectly good pickle, but nothing
    on the `state` path ever re-read it, leaving a permanent GQL traceback
    on the dashboard of a user who had just signed in successfully.
    """
    calls = []

    class NeedsCookies:
        def __init__(self):
            self.loaded = False

        def get_channel_points_context(self, username):
            calls.append("gql")
            if not self.loaded:
                raise AssertionError("GQL called before reload_cookies")
            return SimpleNamespace(community=None)

    gql = NeedsCookies()

    def reload():
        calls.append("reload_cookies")
        gql.loaded = True
        return True

    session = SimpleNamespace(
        gql=gql, reload_cookies=reload, is_logged_in=lambda: True,
        # Mirrors TwitchLogin before any pickle is loaded.
        login=SimpleNamespace(get_auth_token=lambda: None),
    )
    out = Handler(session).handle(
        {"id": 1, "op": "state", "streamers": ["alpha"]},
    )

    assert out["ok"] is True
    assert calls[0] == "reload_cookies"


def test_state_does_not_reload_when_a_token_is_already_held():
    """The common case must stay a single GQL round trip: re-reading the
    pickle on every poll would be pointless file I/O every 60 seconds.
    """
    calls = []

    class Gql:
        def get_channel_points_context(self, username):
            calls.append("gql")
            return SimpleNamespace(community=None)

    session = SimpleNamespace(
        gql=Gql(),
        reload_cookies=lambda: calls.append("reload_cookies"),
        is_logged_in=lambda: True,
        login=SimpleNamespace(get_auth_token=lambda: "a-live-token"),
    )
    Handler(session).handle({"id": 1, "op": "state", "streamers": ["alpha"]})

    assert calls == ["gql"]


def _ctx(**kw):
    """A handler whose channel-points context carries the extra fields."""
    h = handler(balances={"alpha": 10}, live={"42": True})
    h.session.gql.get_channel_points_context = lambda username: (
        points_response(10, **kw) if username == "alpha"
        else SimpleNamespace(community=None)
    )
    return h


def test_one_sums_active_multipliers_into_a_single_factor():
    """Upstream treats "has any multiplier" as subscribed, but the factor
    is the fact we actually have -- multipliers have sources other than a
    sub, so the UI must not be handed a bare boolean called isSubscribed.
    """
    out = _ctx(multipliers=(1.2,))._one("alpha")
    assert out["multiplier"] == 1.2


def test_one_combines_several_multipliers():
    out = _ctx(multipliers=(1.2, 0.3))._one("alpha")
    assert out["multiplier"] == 1.5


def test_one_reports_no_multiplier_as_null_not_one():
    """1.0 would be a claim that a neutral multiplier is active; null says
    Twitch gave us none, which is what the card needs to hide the badge."""
    out = _ctx(multipliers=())._one("alpha")
    assert out["multiplier"] is None


def test_one_flags_an_unclaimed_bonus():
    out = _ctx(claim="claim-1")._one("alpha")
    assert out["claimPending"] is True


def test_one_reports_no_claim_when_none_is_waiting():
    out = _ctx(claim=None)._one("alpha")
    assert out["claimPending"] is False


def test_one_reports_the_active_community_goal():
    out = _ctx(goals=(goal(),))._one("alpha")
    assert out["goal"] == {
        "title": "New emotes", "contributed": 3000, "needed": 10000,
    }


def test_one_ignores_a_finished_or_out_of_stock_goal():
    """A goal that has ended is not something the viewer can contribute to,
    so surfacing it would put a dead progress bar on the card."""
    assert _ctx(goals=(goal(status="ENDED"),))._one("alpha")["goal"] is None
    assert _ctx(goals=(goal(in_stock=False),))._one("alpha")["goal"] is None


def test_one_picks_one_goal_when_a_channel_runs_several():
    """The card has room for one. The least-complete is the one still
    worth contributing to."""
    out = _ctx(goals=(goal(title="Nearly", contributed=9000),
                      goal(title="Fresh", contributed=100)))._one("alpha")
    assert out["goal"]["title"] == "Fresh"


def test_one_survives_a_response_without_the_newer_fields():
    """A miner build whose parser predates these fields must degrade to a
    card without badges, never take the whole state poll down."""
    h = handler(balances={"alpha": 10}, live={"42": True})
    h.session.gql.get_channel_points_context = lambda username: SimpleNamespace(
        community=SimpleNamespace(
            display_name="Alpha",
            channel=SimpleNamespace(
                id="42",
                edge=SimpleNamespace(community_points=SimpleNamespace(balance=10)),
                community_points_settings=SimpleNamespace(is_enabled=True),
            ),
        )
    )
    out = h._one("alpha")
    assert out["multiplier"] is None
    assert out["claimPending"] is False
    assert out["goal"] is None
    assert out["points"] == 10


def test_unknown_channel_reports_the_new_fields_too():
    """Every path through _one must agree on its shape."""
    out = handler(balances={})._one("ghost")
    assert out["multiplier"] is None
    assert out["claimPending"] is False
    assert out["goal"] is None
