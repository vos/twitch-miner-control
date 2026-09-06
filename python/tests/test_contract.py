"""Asserts the upstream miner API surface we depend on still exists.

If this fails after bumping vendor/miner, read
docs/superpowers/specs/2026-08-29-twitch-miner-web-ui-design.md
section "Key findings from upstream source" before changing anything.
"""
import datetime
import inspect
import os
import pathlib
import subprocess
import sys

from TwitchChannelPointsMiner import TwitchChannelPointsMiner
from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from TwitchChannelPointsMiner.classes.Twitch import Twitch
from TwitchChannelPointsMiner.classes.ClientSession import ClientSession
from TwitchChannelPointsMiner.classes.EventHook import EventHook
from TwitchChannelPointsMiner.classes.Settings import Events, Settings
from TwitchChannelPointsMiner.classes.TwitchLogin import TwitchLogin
from TwitchChannelPointsMiner.classes.entities.Streamer import (
    Streamer,
    StreamerSettings,
)
from TwitchChannelPointsMiner.classes.gql.Errors import GQLError, RetryError
from TwitchChannelPointsMiner.classes.gql import Integration
from TwitchChannelPointsMiner.classes.gql.Integration import GQL, GQLFactory
from TwitchChannelPointsMiner.classes.gql.data.Parser import Parser
from TwitchChannelPointsMiner.constants import CLIENT_ID, CLIENT_VERSION, USER_AGENTS

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def params(fn):
    return list(inspect.signature(fn).parameters)


def test_event_hook_surface():
    assert params(EventHook.send) == ["self", "message", "event"]
    assert params(EventHook.validate_record) == ["self", "record"]
    assert params(EventHook.validate_and_send) == ["self", "record"]


def test_events_we_rely_on_exist():
    for name in [
        "STREAMER_ONLINE",
        "STREAMER_OFFLINE",
        "GAIN_FOR_WATCH",
        "GAIN_FOR_CLAIM",
        "GAIN_FOR_RAID",
        "BONUS_CLAIM",
        "JOIN_RAID",
        "DROP_CLAIM",
    ]:
        assert Events.get(name) is not None, name


def test_twitch_login_surface():
    assert params(TwitchLogin.__init__) == [
        "self", "client_id", "device_id", "username", "user_agent", "password",
    ]
    assert params(TwitchLogin.save_cookies) == ["self", "cookies_file"]
    assert params(TwitchLogin.load_cookies) == ["self", "cookies_file"]
    assert params(TwitchLogin.check_login) == ["self"]
    assert params(TwitchLogin.set_token) == ["self", "new_token"]


def test_client_session_and_gql_construction():
    assert "login" in params(ClientSession.__init__)
    assert "user_agent" in params(ClientSession.__init__)
    assert params(GQLFactory.create) == ["self", "client_session"]
    assert params(GQL.get_channel_points_context) == ["self", "username"]
    assert params(GQL.with_is_stream_live_query) == ["self", "channel_id"]
    assert params(GQL.get_id_from_login) == ["self", "streamer_username"]
    assert params(GQL.channel_follows) == ["self", "limit", "order"]
    assert params(GQL.post_gql_request_batch) == ["self", "operation_name", "request_json", "parser"]


def test_streamer_settings_fields_we_expose():
    exposed = {
        "make_predictions", "follow_raid", "claim_drops", "claim_moments",
        "watch_streak", "community_goals", "weekly_rewards", "points_limit",
        "chat",
    }
    assert exposed.issubset(set(StreamerSettings.__slots__))
    assert exposed.issubset(set(params(StreamerSettings.__init__)))
    assert params(Streamer.__init__)[1] == "username"
    assert "settings" in params(Streamer.__init__)
    assert {"ALWAYS", "NEVER", "ONLINE", "OFFLINE"}.issubset(
        {m.name for m in ChatPresence}
    )


def test_constants_used_by_the_session_bootstrap():
    assert isinstance(CLIENT_ID, str) and CLIENT_ID
    assert isinstance(CLIENT_VERSION, str) and CLIENT_VERSION
    assert "FIREFOX" in USER_AGENTS["Linux"]


def test_gql_error_surface_used_by_auth_detection():
    """helpers/state.py's _is_auth_error walks RetryError.errors (a
    list[AttemptStrategy.ExceptionContext], each with an `.exception`
    attribute) looking for a wrapped HTTPError/401. Pin the surface it
    depends on beyond the four named GQL methods."""
    assert issubclass(RetryError, GQLError)
    assert "errors" in params(RetryError.__init__)


def test_settings_logger_is_not_populated_by_merely_importing_the_miner():
    """Pins the trap that produced "Internal Server Error" on every lookup.

    `Settings` is a __slots__ class used as a bare namespace. Upstream's only
    writer of `Settings.logger` is TwitchChannelPointsMiner.__init__, which
    the read-only helpers never run -- and an unset slot read off the class
    silently yields a member_descriptor instead of raising, so the failure
    surfaces far away as `'member_descriptor' object has no attribute
    'anonymiser'`. helpers/_session.py must therefore set it explicitly.

    If this ever starts failing, upstream began populating Settings.logger on
    import and `_configure_settings` may be reconsidered.
    """
    proc = subprocess.run(
        [sys.executable, "-c",
         "from TwitchChannelPointsMiner.classes.Settings import Settings;"
         "print(type(Settings.__dict__['logger']).__name__)"],
        capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": str(REPO_ROOT / "vendor" / "miner")},
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "member_descriptor"
    assert "logger" in Settings.__slots__


def test_gql_redaction_depends_on_settings_logger():
    """The specific upstream coupling the fix exists to satisfy: the GQL
    request path reads `Settings.logger.anonymiser`. Pinned as source text
    because it happens inside a private method that cannot be called without
    a live session."""
    source = inspect.getsource(Integration)
    assert "Settings.logger.anonymiser" in source


def test_get_id_from_login_cannot_report_a_missing_user_as_an_empty_id():
    """`GQL.get_id_from_login`'s docstring promises "an empty string if the
    user doesn't exist", but its parser runs expect_dict over `data.user`,
    and Twitch answers `data.user: null` for an unknown login -- so a missing
    user always arrives as a raised error, never an empty id. helpers/state.py
    translates that into `exists: False`.

    If this fails, upstream fixed the parser to honour its docstring and
    `_is_missing_user_error` can be revisited.
    """
    source = inspect.getsource(Parser.parse_get_id_from_login_response)
    assert 'parse_expected_value(data, "user", expect_dict)' in source


def test_miner_constructor_still_rejects_a_missing_password():
    """Pins why run.py passes a placeholder `password`.

    TwitchChannelPointsMiner.__init__ rejects a falsy password with
    sys.exit(0) before Twitch.login() -- and therefore before the cookie
    branch this app relies on -- is ever reached. run.py works around that
    with COOKIE_AUTH_PLACEHOLDER.

    Pinned as source text because triggering the check for real would
    sys.exit the test process. If this fails, upstream reworked the
    credential validation and the placeholder may no longer be needed.
    """
    source = inspect.getsource(TwitchChannelPointsMiner.__init__)
    assert 'startup_error = "No password"' in source
    assert "sys.exit(0)" in source


def test_password_is_not_used_for_authentication():
    """The placeholder in run.py is safe only because `password` never
    authenticates anything: it reaches TwitchLogin.password, whose sole
    consumer is the Selenium `login_flow_backup`, and upstream's only call
    site passes no password at all.

    If this fails, `password` gained a real consumer and run.py's
    placeholder must be re-examined rather than left in place.
    """
    source = inspect.getsource(TwitchLogin)
    assert "self.login_flow_backup()" in source
    assert params(TwitchLogin.login_flow) == ["self"]


def test_login_prefers_saved_cookies_over_any_login_flow():
    """The branch that makes cookie-based auth work: when
    `<cwd>/cookies/<username>.pkl` exists, Twitch.login() loads it and never
    runs a login flow. This is the path every signed-in install takes."""
    source = inspect.getsource(Twitch.login)
    assert "os.path.isfile(self.cookies_file)" in source
    assert "load_cookies" in source


def test_stream_response_exposes_id_and_created_at():
    """helpers/state.py:_one() reads both off the live query's response.

    If this fails after bumping vendor/miner, the response shape changed
    and the streamer cards' uptime figures are affected. created_at must
    stay a parsed datetime, not a raw string: state.py converts it with
    .timestamp(), which a str does not have.
    """
    from TwitchChannelPointsMiner.classes.gql.data.response.WithIsStreamLiveQuery import (
        Stream,
    )

    assert params(Stream.__init__) == ["self", "_id", "created_at"]
    stream = Stream(_id="s1", created_at=datetime.datetime.now(datetime.timezone.utc))
    assert isinstance(stream.created_at, datetime.datetime)
