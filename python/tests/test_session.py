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
