# Twitch Miner Control UI

Web UI to configure and control
[mpforce1/Twitch-Channel-Points-Miner](https://github.com/mpforce1/Twitch-Channel-Points-Miner).

## Quick start

    git clone --recurse-submodules <this repo>
    echo "APP_PASSWORD=choose-something" > .env
    docker compose up -d

Open http://localhost:8080, unlock with your password, then go to
**Twitch account** and sign in with the device code. Add streamers on the
**Streamers** screen and press **Apply & Restart**.

## Design

- `docs/superpowers/specs/2026-08-29-twitch-miner-web-ui-design.md`
- `docs/superpowers/plans/2026-08-29-twitch-miner-web-ui.md`

## Updating the miner

    git -C vendor/miner pull
    uv run pytest python/tests/test_contract.py

If the contract test fails, the upstream API we depend on has changed. Read
the spec's "Key findings from upstream source" before adapting.

## Not supported

LAN use only — there is no TLS, no per-user accounts, and no rate limiting.
Do not expose this to the internet.
