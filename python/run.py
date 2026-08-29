# -*- coding: utf-8 -*-
"""Adapter entry point. Reads config.json; the web UI writes it.

Hand-edit the TwitchChannelPointsMiner(...) call below for credentials,
notifications and logger settings. The web UI only ever rewrites
config.json, never this file.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "vendor", "miner"))

from TwitchChannelPointsMiner import TwitchChannelPointsMiner
from TwitchChannelPointsMiner.classes.Settings import FollowersOrder
from TwitchChannelPointsMiner.logger import LoggerSettings

from helpers.doorbell import DoorbellHook
from miner_config import build_mine_kwargs, build_streamers

CONFIG_PATH = os.environ.get("MINER_CONFIG", "config.json")
DOORBELL_URL = os.environ.get("DOORBELL_URL", "http://127.0.0.1:8080/internal/doorbell")
DOORBELL_TOKEN = os.environ["DOORBELL_TOKEN"]

with open(CONFIG_PATH, encoding="utf-8") as fh:
    cfg = json.load(fh)

twitch_miner = TwitchChannelPointsMiner(
    username=cfg["username"],
    enable_analytics=False,
    use_hermes=True,
    logger_settings=LoggerSettings(
        save=True,
        console_level=20,
        hooks=[DoorbellHook(DOORBELL_URL, DOORBELL_TOKEN)],
    ),
)

kwargs = build_mine_kwargs(cfg)
twitch_miner.mine(
    streamers=build_streamers(cfg),
    followers=kwargs["followers"],
    followers_order=FollowersOrder[kwargs["followers_order"]],
)
