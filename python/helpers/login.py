"""OAuth 2.0 device-code login, emitting NDJSON progress.

Upstream's login_flow() only logs the user code before blocking, so it cannot
drive a UI. This is a reimplementation of the same public, documented flow
(https://id.twitch.tv/oauth2/device). Everything stateful still goes through
TwitchLogin so the cookie pickle format stays upstream's concern.
"""
import json
import os
import sys
import time

DEVICE_URL = "https://id.twitch.tv/oauth2/device"
TOKEN_URL = "https://id.twitch.tv/oauth2/token"
SCOPES = (
    "channel_read chat:read user_blocks_edit "
    "user_blocks_read user_follows_edit user_read"
)


def _emit(out, payload):
    out.write(json.dumps(payload) + "\n")
    out.flush()


def device_login(session, out=sys.stdout, sleep=time.sleep, now=time.monotonic):
    login = session.login
    response = login.send_oauth_request(
        DEVICE_URL, {"client_id": login.client_id, "scopes": SCOPES}
    )
    if response.status_code != 200:
        _emit(out, {"stage": "error",
                    "error": f"device request failed: HTTP {response.status_code}"})
        return False

    body = response.json()
    interval = body.get("interval", 5)
    deadline = now() + body.get("expires_in", 1800)
    _emit(out, {
        "stage": "code",
        "userCode": body["user_code"],
        "verificationUri": body.get("verification_uri",
                                    "https://www.twitch.tv/activate"),
        "expiresAt": deadline,
    })

    poll = {
        "client_id": login.client_id,
        "device_code": body["device_code"],
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
    }
    while True:
        sleep(interval)
        if now() >= deadline:
            _emit(out, {"stage": "error", "error": "code expired, start again"})
            return False
        token_response = login.send_oauth_request(TOKEN_URL, poll)
        if token_response.status_code != 200:
            _emit(out, {"stage": "pending"})
            continue
        token = token_response.json().get("access_token")
        if not token:
            _emit(out, {"stage": "error", "error": "no access_token in response"})
            return False
        login.set_token(token)
        if not login.check_login():
            _emit(out, {"stage": "error", "error": "token rejected by Twitch"})
            return False
        login.save_cookies(session.cookies_file)
        _emit(out, {"stage": "ok", "username": login.username})
        return True


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    # `python/` for the helpers package, `vendor/miner` for the miner package.
    sys.path.insert(0, os.path.join(here, ".."))
    sys.path.insert(0, os.path.join(here, "..", "..", "vendor", "miner"))
    from helpers._session import build_session

    session = build_session(os.environ["TWITCH_USERNAME"],
                            os.environ.get("COOKIES_DIR", "cookies"))
    os.makedirs(os.path.dirname(session.cookies_file), exist_ok=True)
    sys.exit(0 if device_login(session) else 1)


if __name__ == "__main__":
    main()
