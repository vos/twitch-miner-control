import pytest

from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from TwitchChannelPointsMiner.classes.Settings import Priority
from TwitchChannelPointsMiner.classes.entities.Bet import Condition, DelayMode, Strategy
from TwitchChannelPointsMiner.classes.entities.Streamer import DropsMode, HLSSettings
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
    # From defaults, as a bool: upstream maps True to its own default mode.
    assert settings.claim_drops is DropsMode.LINKED


@pytest.mark.parametrize("name", ["NONE", "LINKED", "ALL"])
def test_claim_drops_mode_name_maps_to_enum(name):
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True, "settings": {"claim_drops": name}},
    ])
    assert build_streamers(c)[0].settings.claim_drops is DropsMode[name]


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


def _hls(mode):
    c = cfg(streamers=[
        {"username": "alpha", "enabled": True,
         "settings": {"simulate_hls_playback": mode}},
    ])
    return build_streamers(c)[0].settings.simulate_hls_playback


def test_simulate_hls_playback_off_reaches_the_miner_as_false():
    assert _hls("OFF") is False


@pytest.mark.parametrize("mode, upstream", [
    ("DROPS", "drops"), ("ALL_SEGMENTS", "enable"), ("LAST_SEGMENT", "disable"),
])
def test_simulate_hls_playback_mode_becomes_hls_settings(mode, upstream):
    hls = _hls(mode)
    assert isinstance(hls, HLSSettings)
    assert hls.watch_all_segments == upstream
    assert hls.refresh_before == 120


def test_unset_simulate_hls_playback_is_left_to_upstream():
    c = cfg(streamers=[{"username": "alpha", "enabled": True, "settings": {}}])
    hls = build_streamers(c)[0].settings.simulate_hls_playback
    # Filled in later by set_default_settings, from StreamerSettings.default().
    assert hls is None


def test_unknown_simulate_hls_playback_mode_is_rejected():
    with pytest.raises(ValueError, match="simulate_hls_playback"):
        _hls("SOMETIMES")


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
    kwargs = build_mine_kwargs(cfg())
    assert kwargs["followers"] is True
    assert kwargs["followers_order"] == "ASC"


def test_mine_kwargs_default_the_miner_wide_options():
    kwargs = build_mine_kwargs(cfg())
    assert kwargs["followers"] is True
    assert kwargs["priority"] is None
    assert kwargs["claim_drops_startup"] is False
    assert kwargs["gql"] is None
    assert kwargs["weekly_rewards"] is None


def test_mine_kwargs_carry_priority_and_startup_claim():
    kwargs = build_mine_kwargs(cfg(miner={
        "priority": ["STREAK", "ORDER"],
        "claim_drops_startup": True,
        "gql": {"attempts": 5, "attempt_interval_seconds": 2},
    }))
    assert kwargs["priority"] == [Priority.STREAK, Priority.ORDER]
    assert kwargs["claim_drops_startup"] is True
    assert kwargs["gql"].attempts == 5
    assert kwargs["gql"].attempt_interval_seconds == 2


def test_weekly_rewards_false_disables_rather_than_configuring():
    assert build_mine_kwargs(cfg(miner={"weekly_rewards": False}))["weekly_rewards"] is False


def test_weekly_rewards_dict_becomes_basic_configuration():
    kwargs = build_mine_kwargs(cfg(miner={"weekly_rewards": {"max_concurrent": 4}}))
    assert kwargs["weekly_rewards"].max_concurrent == 4


# --- the drop slot --------------------------------------------------------

from types import SimpleNamespace

from miner_config import DropSlotSelector, DropSlotSelectorFactory, drop_pools


CAMPAIGNS = {"campaign": object()}


def _streamer(login, claim_drops=DropsMode.LINKED, progressable=False):
    return SimpleNamespace(
        username=login,
        channel_id=f"id-{login}",
        settings=SimpleNamespace(claim_drops=claim_drops),
        # Upstream reads the miner's campaign map; the fake checks it was
        # handed that map rather than something else.
        any_campaign_has_progressable_drop=lambda campaigns: (
            progressable and campaigns is CAMPAIGNS
        ),
    )


class _Inner:
    """Stands in for upstream's chain: picks the given logins, in order."""

    def __init__(self, *logins):
        self.logins = logins
        self.seen_campaigns = None

    def select(self, campaigns, streamers, max_amount):
        self.seen_campaigns = campaigns
        online = {s.username for s in streamers}
        return [f"id-{l}" for l in self.logins if l in online][:max_amount]


def _select(selector, online, max_amount=2):
    return selector.select(CAMPAIGNS, online, max_amount)


def _owned(login, sub):
    return {"username": login, "enabled": True, "settings": {}, "ownedBy": sub}


def test_drop_pools_group_owned_channels_in_config_order():
    c = cfg(streamers=[
        {"username": "manual", "enabled": True, "settings": {}},
        _owned("a1", "sub-a"), _owned("a2", "sub-a"), _owned("B1", "sub-b"),
    ])
    assert drop_pools(c) == [["a1", "a2"], ["b1"]]


def test_drop_pools_skip_disabled_channels():
    c = cfg(streamers=[{**_owned("a1", "sub-a"), "enabled": False},
                       _owned("a2", "sub-a")])
    assert drop_pools(c) == [["a2"]]


def test_a_live_pool_channel_takes_a_slot_from_manual_streamers():
    selector = DropSlotSelector(_Inner("house", "cohh"), [["a1", "a2"]])
    online = [_streamer("house"), _streamer("cohh"), _streamer("a2")]
    assert _select(selector, online) == ["id-a2", "id-house"]


def test_the_inner_choice_stands_when_it_already_holds_a_pool_channel():
    selector = DropSlotSelector(_Inner("house", "a2"), [["a1", "a2"]])
    online = [_streamer("house"), _streamer("a1"), _streamer("a2")]
    assert _select(selector, online) == ["id-house", "id-a2"]


def test_the_higher_ranked_pool_wins_the_slot():
    selector = DropSlotSelector(_Inner("house", "cohh"), [["a1"], ["b1"]])
    online = [_streamer("house"), _streamer("cohh"), _streamer("b1"), _streamer("a1")]
    assert _select(selector, online) == ["id-a1", "id-house"]


def test_only_one_slot_goes_to_drops():
    selector = DropSlotSelector(_Inner("house"), [["a1", "a2"]])
    online = [_streamer("house"), _streamer("a1"), _streamer("a2")]
    assert _select(selector, online) == ["id-a1", "id-house"]


def test_a_pool_channel_with_drops_off_is_not_given_the_slot():
    selector = DropSlotSelector(_Inner("house", "cohh"), [["a1"]])
    online = [_streamer("house"), _streamer("cohh"), _streamer("a1", claim_drops=DropsMode.NONE)]
    assert _select(selector, online) == ["id-house", "id-cohh"]


def test_nothing_changes_without_a_live_pool_channel():
    selector = DropSlotSelector(_Inner("house", "cohh"), [["a1"]])
    online = [_streamer("house"), _streamer("cohh")]
    assert _select(selector, online) == ["id-house", "id-cohh"]


def test_within_a_pool_a_channel_the_miner_can_progress_comes_first():
    selector = DropSlotSelector(_Inner("house", "cohh"), [["a1", "a2"]])
    online = [_streamer("house"), _streamer("cohh"),
              _streamer("a1"), _streamer("a2", progressable=True)]
    assert _select(selector, online) == ["id-a2", "id-house"]


def test_rank_still_beats_progress_across_pools():
    """The preference is within a pool: a lower-ranked pool's progressable
    channel does not jump the subscription ranked above it."""
    selector = DropSlotSelector(_Inner("house", "cohh"), [["a1"], ["b1"]])
    online = [_streamer("house"), _streamer("cohh"),
              _streamer("a1"), _streamer("b1", progressable=True)]
    assert _select(selector, online) == ["id-a1", "id-house"]


def test_the_inner_selector_sees_the_miners_campaigns():
    inner = _Inner("house")
    _select(DropSlotSelector(inner, [["a1"]]), [_streamer("house")])
    assert inner.seen_campaigns is CAMPAIGNS


def test_factory_wraps_the_selector_upstream_builds_from_priority():
    from TwitchChannelPointsMiner.classes.Settings import Priority
    from TwitchChannelPointsMiner.classes.StreamerSelector import PrioritySelector

    selector = DropSlotSelectorFactory([["a1"]]).create([Priority.ORDER])
    assert isinstance(selector, DropSlotSelector)
    assert isinstance(selector.inner, PrioritySelector)


def test_factory_without_pools_leaves_upstreams_selector_alone():
    from TwitchChannelPointsMiner.classes.StreamerSelector import NestedSelector

    assert isinstance(DropSlotSelectorFactory([]).create(None), NestedSelector)
