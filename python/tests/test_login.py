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
