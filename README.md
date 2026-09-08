# Twitch Miner Control

A control panel for
[Twitch Channel Points Miner](https://github.com/mpforce1/Twitch-Channel-Points-Miner) —
a web UI to configure and control the miner, in place of editing
`run.py` by hand.

## ⚠️ Run this on your LAN only

There is no TLS, no per-user accounts, and no rate limiting. Access is a
single shared `APP_PASSWORD` sent over plain HTTP, so anyone who can reach
the port can watch it go by and then log in themselves. **Do not port-forward
this, and do not put it on a public host.** If you need it away from home,
put it behind a VPN such as WireGuard or Tailscale.

Running a points miner also violates the
[Twitch Terms of Service](https://www.twitch.tv/p/legal/terms-of-service/)
and can get the account it signs in as suspended. Use an account you are
willing to lose.

## Disclaimer

Quoting
[upstream](https://github.com/mpforce1/Twitch-Channel-Points-Miner#disclaimer),
which applies to this control panel too:

> This project comes with no guarantee or warranty. You are responsible for
> whatever happens from using this project. It is possible to get soft or hard
> banned by using this project if you are not careful. This is a personal
> project and is in no way affiliated with Twitch.

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

## Updating the miner

    git -C vendor/miner pull
    uv run pytest python/tests/test_contract.py

If the contract test fails, the upstream API we depend on has changed. The
failing assertion names the attribute that moved; adapt `python/run.py`,
`python/miner_config.py` or `python/helpers/` to the new surface.

## Credits

This is a control panel only — all the actual mining is upstream's work.

- [mpforce1/Twitch-Channel-Points-Miner](https://github.com/mpforce1/Twitch-Channel-Points-Miner),
  vendored at `vendor/miner`, which this project imports directly.
- [rdavydov/Twitch-Channel-Points-Miner-v2](https://github.com/rdavydov/Twitch-Channel-Points-Miner-v2),
  the now-archived project mpforce1's fork continues.

## License

[GPL-3.0-only](LICENSE), the same license as upstream. The Python adapters in
`python/` import `TwitchChannelPointsMiner` directly, so this project is a
derivative work of a GPL-3.0 program and carries that license throughout.
