import io
import json
from types import SimpleNamespace

from helpers.login import device_login

SCOPES = (
    "channel_read chat:read user_blocks_edit "
    "user_blocks_read user_follows_edit user_read"
)


class FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


class FakeLogin:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []
        self.token = None
        self.saved_to = None
        self.username = "alex"
        self.client_id = "fake-client-id"

    def send_oauth_request(self, url, data):
        self.requests.append((url, data))
        return self.responses.pop(0)

    def set_token(self, token):
        self.token = token

    def check_login(self):
        return True

    def save_cookies(self, path):
        self.saved_to = path


def run(responses, **kw):
    login = FakeLogin(responses)
    session = SimpleNamespace(login=login, cookies_file="/tmp/alex.pkl")
    out = io.StringIO()
    device_login(session, out=out, sleep=lambda _s: None, now=iter_now(), **kw)
    lines = [json.loads(x) for x in out.getvalue().strip().split("\n")]
    return login, lines


def iter_now(start=0.0):
    counter = {"t": start}

    def _now():
        counter["t"] += 1.0
        return counter["t"]

    return _now


DEVICE_OK = FakeResponse(200, {
    "device_code": "dev", "user_code": "ABCD1234", "interval": 1,
    "expires_in": 1800, "verification_uri": "https://www.twitch.tv/activate",
})


def test_emits_code_then_ok():
    login, lines = run([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    assert lines[0]["stage"] == "code"
    assert lines[0]["userCode"] == "ABCD1234"
    assert lines[0]["verificationUri"] == "https://www.twitch.tv/activate"
    assert lines[-1] == {"stage": "ok", "username": "alex"}


def test_requests_upstreams_scopes():
    login, _ = run([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    assert login.requests[0][1]["scopes"] == SCOPES


def test_pending_is_emitted_while_user_has_not_entered_the_code():
    login, lines = run([
        DEVICE_OK,
        FakeResponse(400, {"message": "authorization_pending"}),
        FakeResponse(200, {"access_token": "tok"}),
    ])
    stages = [l["stage"] for l in lines]
    assert stages == ["code", "pending", "ok"]


def test_token_is_set_and_cookies_saved_on_success():
    login, _ = run([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    assert login.token == "tok"
    assert login.saved_to == "/tmp/alex.pkl"


def test_expired_code_stops_polling_instead_of_looping_forever():
    expiring = FakeResponse(200, {
        "device_code": "dev", "user_code": "ABCD1234", "interval": 1,
        "expires_in": 2, "verification_uri": "https://www.twitch.tv/activate",
    })
    pending = [FakeResponse(400, {}) for _ in range(20)]
    login, lines = run([expiring, *pending])
    assert lines[-1]["stage"] == "error"
    assert "expired" in lines[-1]["error"]


def test_expires_at_is_wall_clock_not_monotonic():
    """expiresAt crosses the NDJSON wire to Node, which renders a countdown
    as `expiresAt - Date.now()`. It must be a wall-clock epoch value, not
    time.monotonic()'s unspecified (typically time-since-boot) epoch.

    The monotonic `now` here starts at a huge offset far from any real wall
    clock epoch, while `wall_clock` returns a small, known, fixed epoch. If
    the implementation ever again derives expiresAt from `now()`, the
    emitted value will land near the huge monotonic offset instead of
    `wall_clock() + expires_in`, and this assertion fails. The polling
    deadline must still be driven by the monotonic clock independently:
    this test's `now` is a plain fixed-value callable (not iter_now()), so
    a poll-expiry regression that reads `now()` instead of `wall_clock()`
    for expiresAt would also change this test's emitted stages, not just
    the numeric value -- but here we only assert the wire value, matching
    what production actually consumes it for.
    """
    fixed_wall_clock_epoch = 1_700_000_000.0
    huge_monotonic_offset = 999_999_999.0

    login = FakeLogin([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    session = SimpleNamespace(login=login, cookies_file="/tmp/alex.pkl")
    out = io.StringIO()
    device_login(
        session,
        out=out,
        sleep=lambda _s: None,
        now=iter_now(start=huge_monotonic_offset),
        wall_clock=lambda: fixed_wall_clock_epoch,
    )
    lines = [json.loads(x) for x in out.getvalue().strip().split("\n")]

    code_line = lines[0]
    assert code_line["stage"] == "code"
    assert code_line["expiresAt"] == fixed_wall_clock_epoch + 1800
    # Must not be anywhere near the monotonic clock's domain.
    assert abs(code_line["expiresAt"] - huge_monotonic_offset) > 1_000_000


def test_device_request_failure_reports_error():
    login, lines = run([FakeResponse(500, {})])
    assert lines[-1]["stage"] == "error"


def test_failed_check_login_is_reported_as_error():
    class BadCheck(FakeLogin):
        def check_login(self):
            return False

    login = BadCheck([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    session = SimpleNamespace(login=login, cookies_file="/tmp/alex.pkl")
    out = io.StringIO()
    device_login(session, out=out, sleep=lambda _s: None, now=iter_now())
    lines = [json.loads(x) for x in out.getvalue().strip().split("\n")]
    assert lines[-1]["stage"] == "error"
    assert login.saved_to is None


class RaisingCheckLogin(FakeLogin):
    """Reproduces the vendored miner's crash on an unresolvable username.

    TwitchLogin.__set_user_id guards with `"user" in json_response["data"]`,
    which is true when the key exists with a null value, then subscripts
    it. Twitch answers {"data": {"user": null}} for any login that does not
    exist -- including the empty string a fresh config carries -- so
    check_login() raises TypeError instead of returning False.
    """

    def check_login(self):
        raise TypeError("'NoneType' object is not subscriptable")


def run_with_login(login, **kw):
    session = SimpleNamespace(login=login, cookies_file="/tmp/alex.pkl")
    out = io.StringIO()
    device_login(session, out=out, sleep=lambda _s: None, now=iter_now(), **kw)
    lines = [json.loads(x) for x in out.getvalue().strip().split("\n")]
    return login, lines


def test_unresolvable_username_reports_an_error_instead_of_crashing():
    login = RaisingCheckLogin([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    login.username = "nosuchuser"
    _, lines = run_with_login(login)
    assert lines[-1]["stage"] == "error"
    assert "nosuchuser" in lines[-1]["error"]


def test_blank_username_is_reported_before_any_network_call():
    login = RaisingCheckLogin([DEVICE_OK, FakeResponse(200, {"access_token": "tok"})])
    login.username = ""
    _, lines = run_with_login(login)
    assert lines[-1]["stage"] == "error"
    assert "username" in lines[-1]["error"].lower()
    # The whole point is not making the user complete the device-code
    # flow before telling them the username is missing.
    assert login.requests == []
    assert lines == [lines[-1]]


def test_pending_keeps_the_code_visible():
    """The UI replaces its whole progress object with each frame, so a bare
    {"stage": "pending"} erased the user code and activation link the user
    was in the middle of typing. Every pending frame has to carry them.
    """
    login, lines = run([
        DEVICE_OK,
        FakeResponse(400, {"message": "authorization_pending"}),
        FakeResponse(200, {"access_token": "tok"}),
    ])
    pending = [l for l in lines if l["stage"] == "pending"]
    assert pending, "expected at least one pending frame"
    for frame in pending:
        assert frame["userCode"] == "ABCD1234"
        assert frame["verificationUri"] == "https://www.twitch.tv/activate"
        assert "expiresAt" in frame
