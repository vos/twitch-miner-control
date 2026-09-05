"""Builds a read-only Twitch session from the miner's own cookie pickle.

Mirrors Twitch.__init__ (vendor/miner/.../classes/Twitch.py:84-123). We never
write cookies here; only helpers/login.py does.
"""
import logging
import os
import string
from dataclasses import dataclass
from secrets import choice, token_hex

from TwitchChannelPointsMiner.classes.ClientSession import ClientSession
from TwitchChannelPointsMiner.classes.Settings import Settings
from TwitchChannelPointsMiner.classes.TwitchLogin import TwitchLogin
from TwitchChannelPointsMiner.classes.gql.Integration import GQL, GQLFactory
from TwitchChannelPointsMiner.constants import CLIENT_ID, CLIENT_VERSION, USER_AGENTS
from TwitchChannelPointsMiner.logger import LoggerSettings

USER_AGENT = USER_AGENTS["Linux"]["FIREFOX"]


def _configure_settings() -> None:
    """Populates the miner's global Settings namespace.

    Every GQL request runs through `Settings.logger.anonymiser`: the request
    JSON is redacted before it is sent (Integration.py __redact_request_json)
    and again when an attempt fails (error_context). `Settings` is a
    __slots__ class used as a bare namespace, never instantiated, and its
    only writer upstream is TwitchChannelPointsMiner.__init__ -- which these
    read-only helpers deliberately never run. Leaving it unset does not raise
    a clean NameError: reading `Settings.logger` off the class hands back the
    slot's member_descriptor, so the first GQL call dies with the puzzling
    `'member_descriptor' object has no attribute 'anonymiser'` and the UI
    shows "Internal Server Error".

    `save=False` because the helpers must never write miner log files; the
    backend captures our stdout/stderr instead. Console output is silenced
    for the same reason state.py's protocol demands it: stdout carries the
    NDJSON responses, and a stray log line there would corrupt the stream.
    """
    Settings.logger = LoggerSettings(save=False, console_level=logging.CRITICAL)


@dataclass
class Session:
    login: TwitchLogin
    gql: GQL
    cookies_file: str

    def reload_cookies(self) -> bool:
        """Re-reads the pickle. The miner may have refreshed the token."""
        if not os.path.isfile(self.cookies_file):
            return False
        self.login.load_cookies(self.cookies_file)
        self.login.set_token(self.login.get_auth_token())
        return True

    def is_logged_in(self) -> bool:
        if not self.reload_cookies():
            return False
        return bool(self.login.check_login())


def build_session(username: str, cookies_dir: str) -> Session:
    _configure_settings()
    device_id = "".join(choice(string.ascii_letters + string.digits) for _ in range(32))
    login = TwitchLogin(CLIENT_ID, device_id, username, USER_AGENT)
    client_session = ClientSession(
        login=login,
        user_agent=USER_AGENT,
        version=CLIENT_VERSION,
        device_id=device_id,
        session_id=token_hex(16),
        version_outdated=True,
    )
    return Session(
        login=login,
        gql=GQLFactory().create(client_session),
        cookies_file=os.path.join(cookies_dir, f"{username}.pkl"),
    )
