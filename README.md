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

## Development

Runs the backend and frontend on the host, without Docker. Requires
Node, [pnpm](https://pnpm.io) and [uv](https://docs.astral.sh/uv/).

    git submodule update --init      # vendor/miner
    pnpm install
    uv sync                          # creates .venv the helpers run from
    cp .env.example .env             # then set APP_PASSWORD
    pnpm dev

Open the Vite URL it prints (http://localhost:5173), **not** port 8080 --
Vite serves the UI with hot reload and proxies `/api` to the backend.

`pnpm dev` runs three watchers, named after the tool each one runs:
`dev:tsc` recompiles the backend, `dev:node` restarts it, and `dev:web`
serves the frontend through Vite. Editing backend TypeScript restarts the
server automatically. Ctrl-C stops all three.

Dev mode reads its configuration from `.env` (see `.env.example` for
what each variable does) and keeps its data in `./.devdata`, so it never
touches the `./data` volume Docker mounts.

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
