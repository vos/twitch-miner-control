"""The Zod schema and miner_config must expose the same settings keys."""
import pathlib
import re

from miner_config import ALLOWED_SETTINGS


def test_zod_schema_maps_exactly_our_allowed_settings():
    source = pathlib.Path("apps/backend/src/config/schema.ts").read_text()

    bool_block = re.search(r"BOOL_SETTINGS = \[(.*?)\] as const", source, re.S)
    assert bool_block, "BOOL_SETTINGS not found"
    bool_settings = set(re.findall(r'"([a-zA-Z]+)"', bool_block.group(1)))
    assert bool_settings, "BOOL_SETTINGS matched but no names captured"

    to_python_block = re.search(r"TO_PYTHON: Record<string, string> = \{(.*?)\}", source, re.S)
    assert to_python_block, "TO_PYTHON map not found"
    to_python_entries = re.findall(r'([a-zA-Z]+):\s*"([a-z_]+)"', to_python_block.group(1))
    assert to_python_entries, "TO_PYTHON map matched but no entries captured"

    to_python_keys = {k for k, _ in to_python_entries}
    to_python_values = [v for _, v in to_python_entries]

    # (a) TO_PYTHON's keys must be exactly BOOL_SETTINGS plus the two non-bool settings.
    # This is the assertion that catches a renamed TS key drifting from BOOL_SETTINGS.
    assert to_python_keys == bool_settings | {"pointsLimit", "chat"}

    # (b) No two TS keys may map to the same Python name. Comparing list length to set
    # length (rather than de-duplicating first) is what catches a colliding key.
    assert len(to_python_values) == len(set(to_python_values))

    # (c) The Python-side value set must exactly match miner_config.ALLOWED_SETTINGS.
    assert set(to_python_values) == set(ALLOWED_SETTINGS)
