"""Asserts the upstream miner API surface we depend on still exists.

If this fails after bumping vendor/miner, read
docs/superpowers/specs/2026-08-29-twitch-miner-web-ui-design.md
section "Key findings from upstream source" before changing anything.
"""
import inspect

from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from TwitchChannelPointsMiner.classes.ClientSession import ClientSession
from TwitchChannelPointsMiner.classes.EventHook import EventHook
from TwitchChannelPointsMiner.classes.Settings import Events
from TwitchChannelPointsMiner.classes.TwitchLogin import TwitchLogin
from TwitchChannelPointsMiner.classes.entities.Streamer import (
    Streamer,
    StreamerSettings,
)
from TwitchChannelPointsMiner.classes.gql.Integration import GQL, GQLFactory


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
    for method in [
        "get_channel_points_context",
        "with_is_stream_live_query",
        "channel_follows",
        "get_id_from_login",
        "post_gql_request_batch",
    ]:
        assert callable(getattr(GQL, method)), method


def test_streamer_settings_fields_we_expose():
    exposed = {
        "make_predictions", "follow_raid", "claim_drops", "claim_moments",
        "watch_streak", "community_goals", "weekly_rewards", "points_limit",
        "chat",
    }
    assert exposed.issubset(set(StreamerSettings.__slots__))
    assert params(Streamer.__init__)[1] == "username"
    assert {"ALWAYS", "NEVER", "ONLINE", "OFFLINE"}.issubset(
        {m.name for m in ChatPresence}
    )
