import os
import pickle

import pytest

from helpers._session import build_session


def write_cookies(cookies_dir, username, token="tok"):
    os.makedirs(cookies_dir, exist_ok=True)
    path = os.path.join(cookies_dir, f"{username}.pkl")
    with open(path, "wb") as fh:
        pickle.dump([{"name": "auth-token", "value": token}], fh)
    return path


def test_cookies_file_follows_upstream_naming(tmp_path):
    session = build_session("alex", str(tmp_path))
    assert session.cookies_file == os.path.join(str(tmp_path), "alex.pkl")


def test_is_logged_in_false_when_no_cookie_file(tmp_path):
    session = build_session("alex", str(tmp_path))
    assert session.is_logged_in() is False


def test_is_logged_in_delegates_to_check_login(tmp_path, monkeypatch):
    write_cookies(str(tmp_path), "alex")
    session = build_session("alex", str(tmp_path))
    # TwitchLogin uses __slots__ (no __dict__), so instance-level
    # monkeypatch.setattr is rejected with "attribute is read-only".
    # Patch the class instead; monkeypatch still restores it afterwards.
    monkeypatch.setattr(type(session.login), "check_login", lambda self: True)
    assert session.is_logged_in() is True


def test_reload_cookies_returns_false_when_file_missing(tmp_path):
    session = build_session("alex", str(tmp_path))
    assert session.reload_cookies() is False


def test_reload_cookies_reads_token_written_by_the_miner(tmp_path, monkeypatch):
    write_cookies(str(tmp_path), "alex", token="fresh")
    session = build_session("alex", str(tmp_path))
    # See note above: TwitchLogin's __slots__ forces class-level patching.
    monkeypatch.setattr(type(session.login), "get_auth_token", lambda self: "fresh")
    seen = []
    monkeypatch.setattr(type(session.login), "set_token", lambda self, tok: seen.append(tok))
    assert session.reload_cookies() is True
    assert seen == ["fresh"]


def test_gql_is_constructed(tmp_path):
    session = build_session("alex", str(tmp_path))
    assert hasattr(session.gql, "get_channel_points_context")


# --- Regression: the GQL layer needs Settings.logger ---------------------


def _reset_settings_logger():
    """Clears Settings.logger back to its unset (slot descriptor) state, so a
    test sees exactly what a fresh `python helpers/state.py` process sees.
    Settings uses __slots__ and is never instantiated, so an unset `logger`
    reads back as the class's member_descriptor rather than raising.
    """
    from TwitchChannelPointsMiner.classes.Settings import Settings

    try:
        del Settings.logger
    except AttributeError:
        pass


def test_build_session_configures_settings_logger():
    """Regression guard for "Internal Server Error" on every Streamers add.

    The miner's GQL layer redacts each request through
    `Settings.logger.anonymiser` (Integration.py __redact_request_json and
    error_context). `Settings` is a __slots__ class used as a namespace and
    is only ever populated by TwitchChannelPointsMiner.__init__, which the
    helpers deliberately never run. Without this, the very first GQL call
    raises `AttributeError: 'member_descriptor' object has no attribute
    'anonymiser'`, which the handler reports as code GQL -> HTTP 500.
    """
    from TwitchChannelPointsMiner.classes.Settings import Settings
    from TwitchChannelPointsMiner.logger import LoggerSettings

    _reset_settings_logger()
    import importlib

    import helpers._session as session_module

    importlib.reload(session_module)
    session_module.build_session("someone", "cookies")

    assert isinstance(Settings.logger, LoggerSettings)
    assert Settings.logger.anonymiser is not None
    # The helpers must never write miner log files of their own.
    assert Settings.logger.save is False


def test_gql_request_json_redaction_works_after_build_session():
    """Exercises the real redaction code path the fake GQL in test_state.py
    cannot reach: `FakeGQL.get_id_from_login` never touches
    Settings.logger, which is why the unit suite stayed green while every
    real lookup failed.
    """
    _reset_settings_logger()
    import importlib

    import helpers._session as session_module

    importlib.reload(session_module)
    session_module.build_session("someone", "cookies")

    from TwitchChannelPointsMiner.classes.Settings import Settings

    # The two attributes the redaction path actually calls.
    assert Settings.logger.anonymiser.username("shroud") is not None
    assert Settings.logger.anonymiser.strict in (True, False)
