"""Maps the backend-owned config.json onto miner objects.

Pure functions only, so they are testable without starting a miner.
The accepted shape here IS the contract; apps/backend/src/config/schema.ts
mirrors it in Zod.
"""
from TwitchChannelPointsMiner.classes.Chat import ChatPresence
from TwitchChannelPointsMiner.classes.entities.Streamer import (
    Streamer,
    StreamerSettings,
)

BOOL_SETTINGS = (
    "make_predictions",
    "follow_raid",
    "claim_drops",
    "claim_moments",
    "watch_streak",
    "community_goals",
    "weekly_rewards",
)
ALLOWED_SETTINGS = frozenset(BOOL_SETTINGS + ("points_limit", "chat"))


def _settings(defaults: dict, overrides: dict) -> StreamerSettings:
    merged = {**defaults, **overrides}
    unknown = set(merged) - ALLOWED_SETTINGS
    if unknown:
        raise ValueError(f"unknown streamer settings: {sorted(unknown)}")
    if "chat" in merged and merged["chat"] is not None:
        merged["chat"] = ChatPresence[merged["chat"]]
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
    return {
        "followers": bool(cfg.get("followers", False)),
        "followers_order": cfg.get("followersOrder", "ASC"),
    }
