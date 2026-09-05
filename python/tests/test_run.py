"""Pins the miner bootstrap in python/run.py.

These run run.py as a subprocess the way apps/backend/src/miner/supervisor.ts
does, because the failure they guard against happens inside
TwitchChannelPointsMiner.__init__ -- before any function this repo owns is
called, so nothing importable can be asserted on instead.
"""
import json
import os
import pathlib
import pickle
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
RUN_SCRIPT = REPO_ROOT / "python" / "run.py"

CONFIG = {
    "version": 1,
    "username": "someone",
    "followers": False,
    "followersOrder": "ASC",
    "defaults": {},
    "streamers": [{"username": "alpha", "enabled": True, "settings": {}}],
}


def _run_miner(tmp_path, config=None, with_cookies=True, timeout=45):
    """Spawns run.py with the env and cwd index.ts gives the supervisor.

    A cookie file is planted by default: Twitch.login() only reads cookies
    when `<cwd>/cookies/<username>.pkl` exists, and that is the branch the
    web UI always takes -- the device-code sign-in wrote that file, so the
    miner must never ask for a password.
    """
    config = config if config is not None else CONFIG
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")

    if with_cookies:
        cookies_dir = tmp_path / "cookies"
        cookies_dir.mkdir(exist_ok=True)
        # Shape mirrors TwitchLogin.save_cookies: a list of cookie dicts.
        with open(cookies_dir / f"{config['username']}.pkl", "wb") as fh:
            pickle.dump(
                [{"name": "auth-token", "value": "deadbeef"},
                 {"name": "persistent", "value": "12345"}],
                fh,
            )

    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(REPO_ROOT / "python"), str(REPO_ROOT / "vendor" / "miner")]
    )
    env["MINER_CONFIG"] = str(config_path)
    env["DOORBELL_TOKEN"] = "test-token"
    env["DOORBELL_URL"] = "http://127.0.0.1:8080/internal/doorbell"
    # The miner is a long-running process: once it clears the credential
    # check it starts a real mining session and never exits on its own. We
    # only care about how far it gets through startup, so it is capped and
    # whatever it printed by then is what gets asserted on. A rejection at
    # the credential check exits immediately, well inside this budget.
    proc = subprocess.Popen(
        [sys.executable, str(RUN_SCRIPT)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        cwd=str(tmp_path), env=env,
    )
    try:
        output, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        output, _ = proc.communicate()
    return output


def test_miner_does_not_exit_asking_for_a_password(tmp_path):
    """Regression guard for the miner badge stuck on "crashed".

    TwitchChannelPointsMiner.__init__ rejects a falsy `password` and calls
    sys.exit(0) before Twitch.login() ever runs -- so the miner died at boot
    with "No password, exiting..." even though a valid cookie was sitting
    right there. This app has no password to give: it authenticates by
    device code and the saved cookie pickle.

    Asserted on the miner's own startup error text rather than the exit
    code, because sys.exit(0) makes a credential rejection indistinguishable
    from a clean shutdown by status alone -- which is exactly why the
    supervisor logged "exited after 264ms with code 0" and parked in CRASHED.
    """
    combined = _run_miner(tmp_path)
    assert "No password" not in combined, combined
    assert "Please edit your configuration file" not in combined, combined
    assert "exiting..." not in combined, combined
    # Positive proof it got past the check into real startup, so that
    # neutering the guard upstream could not make this test vacuously pass.
    assert "Start session" in combined, combined


def test_miner_still_refuses_to_start_without_a_username(tmp_path):
    """Guards the other side of the fix: the credential check must not be
    disabled wholesale. A blank username is a real misconfiguration the
    miner should still reject -- and it is reachable, since config.json
    ships `"username": ""` until the user sets one in Settings.
    """
    combined = _run_miner(tmp_path, config={**CONFIG, "username": ""},
                          with_cookies=False, timeout=30)
    assert "No username" in combined, combined
