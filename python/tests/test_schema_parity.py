"""The Zod schema and miner_config must expose the same settings keys."""
import json
import pathlib
import re

from miner_config import ALLOWED_SETTINGS


def test_zod_schema_maps_exactly_our_allowed_settings():
    source = pathlib.Path("apps/backend/src/config/schema.ts").read_text()
    block = re.search(r"TO_PYTHON: Record<string, string> = \{(.*?)\}", source, re.S)
    assert block, "TO_PYTHON map not found"
    python_names = set(re.findall(r':\s*"([a-z_]+)"', block.group(1)))
    assert python_names == set(ALLOWED_SETTINGS)
