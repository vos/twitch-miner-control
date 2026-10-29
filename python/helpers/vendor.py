"""Imports the vendored miner from any working directory.

The miner finds its translations at the relative path `locales`
(LoggerSettings builds `Translator("locales")`), and it does so while the
package is still importing: TwitchChannelPointsMiner.__init__ takes
`LoggerSettings()` as a default argument. Every process this app spawns
runs with cwd = the data dir, where cookies/ and logs/ live, so a plain
import dies there with FileNotFoundError before any of our code runs.

import_miner() performs that first import from inside the miner's own
checkout and then puts the working directory back. Later imports are
served from sys.modules and never look at the cwd again. Every
LoggerSettings this app builds must still pass `translator=` explicitly,
for the same reason.
"""
import importlib.util
import os
import sys


def miner_root() -> str:
    """The checkout holding the TwitchChannelPointsMiner package.

    Located with find_spec, which reads sys.path without executing the
    package -- executing it is exactly what cannot happen yet.
    """
    spec = importlib.util.find_spec("TwitchChannelPointsMiner")
    if spec is None or not spec.submodule_search_locations:
        raise ModuleNotFoundError(
            "TwitchChannelPointsMiner is not on sys.path -- is vendor/miner checked out?"
        )
    return os.path.dirname(os.path.abspath(spec.submodule_search_locations[0]))


def locales_dir() -> str:
    return os.path.join(miner_root(), "locales")


def import_miner() -> str:
    """Imports the miner package; returns its locales directory."""
    if "TwitchChannelPointsMiner" not in sys.modules:
        cwd = os.getcwd()
        os.chdir(miner_root())
        try:
            import TwitchChannelPointsMiner  # noqa: F401
        finally:
            os.chdir(cwd)
    return locales_dir()
