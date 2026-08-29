"""Long-lived NDJSON server exposing structured miner state.

One request per stdin line, one response per stdout line. Reads go through
the miner's own GQL layer so persisted-query hashes stay upstream's problem.
"""
import json
import os
import sys

AUTH_MARKERS = ("401", "unauthorized", "authentication")


def _is_auth_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in AUTH_MARKERS)


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
