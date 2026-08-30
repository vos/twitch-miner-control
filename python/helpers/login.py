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


def device_login(session, out=sys.stdout, sleep=time.sleep, now=time.monotonic,
                  wall_clock=time.time):
    login = session.login
    # A fresh config carries username "", which Twitch resolves to
    # {"data": {"user": null}} and which then crashes the vendored
    # __set_user_id. Fail before sending the user through the whole
    # device-code flow only to reject the token at the very end.
    if not (login.username or "").strip():
        _emit(out, {"stage": "error",
                    "error": "no Twitch username set -- add one in Settings first"})
        return False
    response = login.send_oauth_request(
        DEVICE_URL, {"client_id": login.client_id, "scopes": SCOPES}
    )
    if response.status_code != 200:
        _emit(out, {"stage": "error",
                    "error": f"device request failed: HTTP {response.status_code}"})
        return False

    body = response.json()
    interval = body.get("interval", 5)
    expires_in = body.get("expires_in", 1800)
    # `deadline` drives the internal polling loop below and must be monotonic
    # (immune to NTP steps/DST changes). `expiresAt` crosses the NDJSON wire
    # to a Node process that renders a countdown from it, so it must be a
    # wall-clock epoch value -- time.monotonic()'s epoch is unspecified
    # (typically time-since-boot) and meaningless outside this process.
    deadline = now() + expires_in
    _emit(out, {
        "stage": "code",
        "userCode": body["user_code"],
        "verificationUri": body.get("verification_uri",
                                    "https://www.twitch.tv/activate"),
        "expiresAt": wall_clock() + expires_in,
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
        # TwitchLogin.__set_user_id guards with `"user" in
        # json_response["data"]`, which is true when the key is present
        # with a null value, and then subscripts it. Twitch answers
        # {"data": {"user": null}} for any login that does not resolve --
        # a typo, a renamed account, or the empty string a fresh config
        # carries -- so check_login() raises TypeError rather than
        # returning False. Report that as a normal login error instead of
        # exiting non-zero with a traceback the UI cannot interpret.
        try:
            logged_in = login.check_login()
        except TypeError:
            _emit(out, {
                "stage": "error",
                "error": f"Twitch has no account named {login.username!r} -- "
                         "check the username in Settings",
            })
            return False
        if not logged_in:
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
