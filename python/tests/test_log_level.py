"""Pins the miner's file log level to MINER_LOG_LEVEL.

The backend validates the value before spawning (config/logLevel.ts), so
these cover run.py's own fallback: it is also runnable by hand, outside
the supervisor, where the variable may be absent or wrong.
"""
import importlib
import logging
import os
import pathlib
import sys

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "python"))
sys.path.insert(0, str(REPO_ROOT / "vendor" / "miner"))


def _file_level(monkeypatch, value):
    """Reads run.py's resolver with MINER_LOG_LEVEL set to `value`.

    run.py builds a miner at import time, so the function is lifted out of
    the source rather than imported -- importing the module would try to
    start a real mining session.
    """
    if value is None:
        monkeypatch.delenv("MINER_LOG_LEVEL", raising=False)
    else:
        monkeypatch.setenv("MINER_LOG_LEVEL", value)

    source = (REPO_ROOT / "python" / "run.py").read_text(encoding="utf-8")
    start = source.index("def _file_level()")
    end = source.index("with open(CONFIG_PATH")
    namespace = {"logging": logging, "os": os}
    exec(compile(source[start:end], "run.py", "exec"), namespace)
    return namespace["_file_level"]()


def test_defaults_to_info_not_upstream_debug(monkeypatch):
    """Upstream's LoggerSettings defaults file_level to DEBUG, which wrote
    267MB in one day -- almost all keepalives and connection chatter."""
    assert _file_level(monkeypatch, None) == logging.INFO


@pytest.mark.parametrize(
    "name,expected",
    [
        ("DEBUG", logging.DEBUG),
        ("INFO", logging.INFO),
        ("WARNING", logging.WARNING),
        ("ERROR", logging.ERROR),
        ("CRITICAL", logging.CRITICAL),
    ],
)
def test_accepts_every_level(monkeypatch, name, expected):
    assert _file_level(monkeypatch, name) == expected


def test_accepts_lowercase(monkeypatch):
    assert _file_level(monkeypatch, "debug") == logging.DEBUG


def test_falls_back_on_a_bad_level(monkeypatch):
    """getLevelName() hands back the string unchanged for an unknown name
    rather than raising, so a typo would otherwise reach setLevel() and
    crash the miner at boot over a log setting."""
    assert _file_level(monkeypatch, "VERBOSE") == logging.INFO
    assert _file_level(monkeypatch, "") == logging.INFO
