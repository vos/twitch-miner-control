import pytest

from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from miner_config import build_mine_kwargs, build_streamers

BASE = {
    "version": 1,
    "followers": True,
    "followersOrder": "ASC",
    "defaults": {"make_predictions": False, "claim_drops": True},
    "streamers": [],
}


def cfg(**over):
    return {**BASE, **over}


def test_disabled_streamers_are_excluded():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {}},
        {"username": "beta", "enabled": False, "settings": {}},
    ])
    assert [s.username for s in build_streamers(c)] == ["alpha"]


def test_order_is_preserved_because_order_is_priority():
    c = cfg(streamers=[
        {"username": "c", "enabled": True, "settings": {}},
        {"username": "a", "enabled": True, "settings": {}},
        {"username": "b", "enabled": True, "settings": {}},
    ])
    assert [s.username for s in build_streamers(c)] == ["c", "a", "b"]


def test_defaults_apply_and_per_streamer_settings_override():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True,
         "settings": {"make_predictions": True}},
    ])
    settings = build_streamers(c)[0].settings
    assert settings.make_predictions is True   # overridden
    assert settings.claim_drops is True        # from defaults


def test_chat_presence_string_maps_to_enum():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"chat": "NEVER"}},
    ])
    assert build_streamers(c)[0].settings.chat is ChatPresence.NEVER


def test_points_limit_false_is_preserved_not_coerced_to_zero():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True,
         "settings": {"points_limit": False}},
    ])
    assert build_streamers(c)[0].settings.points_limit is False


def test_unknown_setting_key_is_rejected():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"evil": 1}},
    ])
    with pytest.raises(ValueError, match="evil"):
        build_streamers(c)


def test_mine_kwargs_carry_follower_options():
    assert build_mine_kwargs(cfg()) == {"followers": True, "followers_order": "ASC"}
