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

# The miner's constructor rejects a falsy `password` and calls sys.exit(0)
# before Twitch.login() is ever reached -- so without this the miner died at
# boot with "No password, exiting..." and the UI badge sat on "crashed", even
# with a perfectly good cookie on disk.
#
# There is no password to supply: this app signs in by device code and the
# saved cookie pickle, which is the branch Twitch.login() takes whenever
# `<cwd>/cookies/<username>.pkl` exists (Twitch.py:117). The value is never
# used for authentication -- `password` reaches only TwitchLogin.password,
# whose sole consumer is the Selenium `login_flow_backup`, and that call site
# both passes no password and is commented out upstream
# (TwitchLogin.py:175-176). So this is a placeholder that satisfies a stale
# validation check, not a credential.
#
# It must still be non-default: the constructor rejects the literal
# "write-your-secure-psw" as an unedited example value.
COOKIE_AUTH_PLACEHOLDER = "unused-cookie-auth"

twitch_miner = TwitchChannelPointsMiner(
    username=cfg["username"],
    password=COOKIE_AUTH_PLACEHOLDER,
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
