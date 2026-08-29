import io
import json
from types import SimpleNamespace

import pytest

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
