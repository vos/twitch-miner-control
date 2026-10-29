"""Maps the backend-owned config.json onto miner objects.

Pure functions only, so they are testable without starting a miner.
The accepted shape here IS the contract; apps/backend/src/config/schema.ts
mirrors it in Zod.
"""
from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from TwitchChannelPointsMiner.classes.ClipVodWatcher import BasicConfiguration
from TwitchChannelPointsMiner.classes.Settings import Priority
from TwitchChannelPointsMiner.classes.StreamerSelector import (
    StreamerSelector,
    StreamerSelectorFactory,
)
from TwitchChannelPointsMiner.classes.entities.Bet import (
    BetSettings,
    Condition,
    DelayMode,
    FilterCondition,
    Strategy,
)
from TwitchChannelPointsMiner.classes.entities.Streamer import (
    DropsMode,
    HLSSettings,
    Streamer,
    StreamerSettings,
)
from TwitchChannelPointsMiner.utils.AttemptStrategy import AttemptStrategy
from TwitchChannelPointsMiner.utils.Utils import normalise_username

BOOL_SETTINGS = (
    "make_predictions",
    "follow_raid",
    "claim_moments",
    "watch_streak",
    "community_goals",
    "weekly_rewards",
)
ALLOWED_SETTINGS = frozenset(
    BOOL_SETTINGS
    + ("claim_drops", "points_limit", "chat", "bet", "simulate_hls_playback")
)

# The playback modes the UI offers, onto HLSSettings.watch_all_segments.
# refresh_before stays at upstream's default of two minutes.
HLS_MODES = {"DROPS": "drops", "ALL_SEGMENTS": "enable", "LAST_SEGMENT": "disable"}
HLS_REFRESH_BEFORE = 2 * 60

BET_ENUMS = {"strategy": Strategy, "delay_mode": DelayMode}
ALLOWED_BET = frozenset(
    ("strategy", "percentage", "percentage_gap", "max_points", "minimum_points",
     "stealth_mode", "delay", "delay_mode", "filter_condition")
)
ALLOWED_FILTER = frozenset(("by", "where", "value"))


def _reject_unknown(merged, allowed, what):
    unknown = set(merged) - allowed
    if unknown:
        raise ValueError(f"unknown {what}: {sorted(unknown)}")


def _filter_condition(raw: dict) -> FilterCondition:
    _reject_unknown(raw, ALLOWED_FILTER, "bet filter_condition keys")
    return FilterCondition(
        by=raw.get("by"),
        where=Condition[raw["where"]] if raw.get("where") else None,
        value=raw.get("value"),
    )


def _bet(raw: dict) -> BetSettings:
    _reject_unknown(raw, ALLOWED_BET, "bet settings")
    kwargs = {k: v for k, v in raw.items() if k != "filter_condition"}
    for name, enum in BET_ENUMS.items():
        if kwargs.get(name) is not None:
            kwargs[name] = enum[kwargs[name]]
    if raw.get("filter_condition") is not None:
        kwargs["filter_condition"] = _filter_condition(raw["filter_condition"])
    return BetSettings(**kwargs)


def _settings(defaults: dict, overrides: dict) -> StreamerSettings:
    merged = {**defaults, **overrides}
    _reject_unknown(merged, ALLOWED_SETTINGS, "streamer settings")
    if merged.get("chat") is not None:
        merged["chat"] = ChatPresence[merged["chat"]]
    if merged.get("bet") is not None:
        merged["bet"] = _bet(merged["bet"])
    # A DropsMode name. Upstream also takes a bool, which it maps itself.
    if isinstance(merged.get("claim_drops"), str):
        merged["claim_drops"] = DropsMode[merged["claim_drops"]]
    hls = merged.get("simulate_hls_playback")
    if hls == "OFF":
        merged["simulate_hls_playback"] = False
    elif hls is not None:
        if hls not in HLS_MODES:
            raise ValueError(f"unknown simulate_hls_playback mode: {hls!r}")
        merged["simulate_hls_playback"] = HLSSettings(
            refresh_before=HLS_REFRESH_BEFORE, watch_all_segments=HLS_MODES[hls]
        )
    return StreamerSettings(**merged)


def build_streamers(cfg: dict) -> list[Streamer]:
    """Builds Streamer objects in config order. Order is priority."""
    defaults = cfg.get("defaults") or {}
    return [
        Streamer(s["username"], settings=_settings(defaults, s.get("settings") or {}))
        for s in cfg["streamers"]
        if s.get("enabled", True)
    ]


def build_mine_kwargs(cfg: dict) -> dict:
    """Miner-wide options. `None` means "let upstream pick its default",
    which is not the same as False -- weekly_rewards=False disables the
    feature, weekly_rewards=None takes upstream's BasicConfiguration. The
    same holds for watch_streak_recovery, which shares that dataclass."""
    miner = cfg.get("miner") or {}

    priority = miner.get("priority")
    gql = miner.get("gql")
    weekly = miner.get("weekly_rewards")
    recovery = miner.get("watch_streak_recovery")

    return {
        "followers": bool(cfg.get("followers", False)),
        "followers_order": cfg.get("followersOrder", "ASC"),
        "priority": [Priority[p] for p in priority] if priority else None,
        "claim_drops_startup": bool(miner.get("claim_drops_startup", False)),
        "gql": AttemptStrategy(**gql) if gql else None,
        "weekly_rewards": (
            BasicConfiguration(**weekly) if isinstance(weekly, dict) else weekly
        ),
        "watch_streak_recovery": (
            BasicConfiguration(**recovery) if isinstance(recovery, dict) else recovery
        ),
    }


def drop_pools(cfg: dict) -> list[list[str]]:
    """The drop subscriptions' channels, one list per subscription.

    In config order, which the backend writes in subscription rank order,
    so the first pool is the highest-ranked campaign's.
    """
    pools: dict[str, list[str]] = {}
    for s in cfg["streamers"]:
        owner = s.get("ownedBy")
        if owner is None or not s.get("enabled", True):
            continue
        pools.setdefault(owner, []).append(normalise_username(s["username"]))
    return list(pools.values())


class DropSlotSelector(StreamerSelector):
    """Holds one watch slot for a drop subscription's channel.

    Upstream's DROPS priority picks whichever channel has the most drop
    progress, across every campaign the roster happens to run -- it has no
    notion of the campaigns the user subscribed to, or of their rank. So
    with two hand-added streamers live, they can take both slots and the
    subscribed campaign makes no progress.

    One slot only: the other stays with the configured priorities, which
    pick first so the slot they rank highest is the one kept.
    """

    def __init__(self, inner: StreamerSelector, pools: list[list[str]]):
        self.inner = inner
        self.pools = pools
        self.pooled = {login for pool in pools for login in pool}

    def select(self, campaigns, streamers, max_amount: int) -> list[str]:
        chosen = self.inner.select(campaigns, streamers, max_amount)
        by_id = {s.channel_id: s for s in streamers}
        if any(
            normalise_username(by_id[c].username) in self.pooled
            for c in chosen if c in by_id
        ):
            return chosen
        candidate = self._candidate(campaigns, streamers)
        if candidate is None or max_amount <= 0:
            return chosen
        rest = [c for c in chosen if c != candidate.channel_id]
        return [candidate.channel_id, *rest][:max_amount]

    def _candidate(self, campaigns, streamers):
        """The channel to hold the slot for, pools in rank order.

        Within a pool, one the miner itself can progress a drop on comes
        first: its campaign map knows when a channel's drops are done or
        its account link is missing. That map fills in over the miner's
        first minutes, and track-and-lane campaigns never enter it, so a
        pool with no such channel still gets its first live one.
        """
        by_login = {
            normalise_username(s.username): s
            for s in streamers
            if s.settings.claim_drops != DropsMode.NONE
        }
        for pool in self.pools:
            live = [by_login[login] for login in pool if login in by_login]
            for streamer in live:
                if streamer.any_campaign_has_progressable_drop(campaigns):
                    return streamer
            if live:
                return live[0]
        return None


class DropSlotSelectorFactory(StreamerSelectorFactory):
    """Wraps whatever selector `priority` builds, configured or default."""

    def __init__(self, pools: list[list[str]]):
        self.pools = pools

    def create(self, priority) -> StreamerSelector:
        inner = super().create(priority)
        return DropSlotSelector(inner, self.pools) if self.pools else inner
