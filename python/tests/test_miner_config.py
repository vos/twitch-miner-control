import pytest

from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from TwitchChannelPointsMiner.classes.entities.Bet import Condition, DelayMode, Strategy
from TwitchChannelPointsMiner.classes.entities.Streamer import HLSSettings
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


def test_bet_dict_becomes_bet_settings_with_enums():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"bet": {
            "strategy": "HIGH_ODDS",
            "percentage_gap": 30,
            "delay_mode": "FROM_START",
            "filter_condition": {"by": "total_users", "where": "LTE", "value": 800},
        }}},
    ])
    bet = build_streamers(c)[0].settings.bet
    assert bet.strategy is Strategy.HIGH_ODDS
    assert bet.percentage_gap == 30
    assert bet.delay_mode is DelayMode.FROM_START
    assert bet.filter_condition.by == "total_users"
    assert bet.filter_condition.where is Condition.LTE
    assert bet.filter_condition.value == 800


def test_bet_without_a_filter_condition_leaves_it_unset():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"bet": {"percentage": 7}}},
    ])
    bet = build_streamers(c)[0].settings.bet
    assert bet.percentage == 7
    assert bet.filter_condition is None


def test_simulate_hls_playback_false_is_preserved_not_coerced():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True,
         "settings": {"simulate_hls_playback": False}},
    ])
    assert build_streamers(c)[0].settings.simulate_hls_playback is False


def test_simulate_hls_playback_dict_becomes_hls_settings():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True,
         "settings": {"simulate_hls_playback": {"refresh_before": 90}}},
    ])
    hls = build_streamers(c)[0].settings.simulate_hls_playback
    assert isinstance(hls, HLSSettings)
    assert hls.refresh_before == 90


def test_unknown_bet_key_is_rejected():
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"bet": {"evil": 1}}},
    ])
    with pytest.raises(ValueError, match="evil"):
        build_streamers(c)


def test_per_streamer_bet_replaces_the_default_bet_wholesale():
    """A dict merge is shallow, so this documents the chosen semantics:
    a streamer that sets `bet` owns the whole block, rather than having
    its keys merged one by one into the default bet."""
    c = cfg(defaults={"bet": {"percentage": 5, "max_points": 100}},
            streamers=[{"username": "alpha", "enabled": True,
                        "settings": {"bet": {"percentage": 9}}}])
    bet = build_streamers(c)[0].settings.bet
    assert bet.percentage == 9
    assert bet.max_points is None


def test_mine_kwargs_carry_follower_options():
    assert build_mine_kwargs(cfg()) == {"followers": True, "followers_order": "ASC"}
