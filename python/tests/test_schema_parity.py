"""The Zod schema and miner_config must expose the same settings keys."""
import pathlib
import re

from miner_config import ALLOWED_BET, ALLOWED_FILTER, ALLOWED_SETTINGS

SOURCE = pathlib.Path("apps/backend/src/config/schema.ts")


def _block(source: str, pattern: str) -> str:
    match = re.search(pattern, source, re.S)
    assert match, f"{pattern} not found in schema.ts"
    return match.group(1)


def _entries(block: str) -> list[tuple[str, str]]:
    return re.findall(r'([a-zA-Z]+):\s*"([a-z_]+)"', block)


def test_zod_schema_maps_exactly_our_allowed_settings():
    source = SOURCE.read_text()

    bool_settings = set(re.findall(
        r'"([a-zA-Z]+)"', _block(source, r"BOOL_SETTINGS = \[(.*?)\] as const")))
    assert bool_settings

    entries = _entries(_block(source, r"TO_PYTHON: Record<string, string> = \{(.*?)\n\}"))
    assert entries
    keys = {k for k, _ in entries}
    values = [v for _, v in entries]

    # (a) TO_PYTHON's keys are exactly BOOL_SETTINGS plus the non-bool settings.
    # This is the assertion that catches a renamed TS key drifting from BOOL_SETTINGS.
    assert keys == bool_settings | {"pointsLimit", "chat", "bet", "simulateHlsPlayback"}

    # (b) No two TS keys may map to the same Python name. Comparing list length to set
    # length (rather than de-duplicating first) is what catches a colliding key.
    assert len(values) == len(set(values))

    # (c) The Python-side value set must exactly match miner_config.ALLOWED_SETTINGS.
    assert set(values) == set(ALLOWED_SETTINGS)


def test_nested_maps_match_the_allowed_nested_keys():
    """The nested maps are what keep a bet dict's inner keys renamed. A key
    added to one side only would hand Python a dict StreamerSettings rejects,
    which is a miner that dies at boot rather than a test that fails here."""
    source = SOURCE.read_text()
    nested = _block(
        source, r"NESTED_TO_PYTHON: Record<string, Record<string, string>> = \{(.*?)\n\};")

    bet = _entries(_block(nested, r"bet: \{(.*?)\},\n"))
    assert {v for _, v in bet} == set(ALLOWED_BET)

    filt = _entries(_block(nested, r"filterCondition: \{(.*?)\},"))
    assert {v for _, v in filt} == set(ALLOWED_FILTER)

    hls = _entries(_block(nested, r"simulateHlsPlayback: \{(.*?)\},"))
    assert {v for _, v in hls} == {"refresh_before"}
