# Twitch Miner Control

A control panel for
[Twitch Channel Points Miner](https://github.com/mpforce1/Twitch-Channel-Points-Miner) —
a web UI to configure and control the miner, in place of editing
`run.py` by hand.

## ⚠️ Run this on your LAN only

There is no TLS and no per-user accounts. Access is a single shared
`APP_PASSWORD` sent over plain HTTP, so anyone who can reach the port can
watch it go by and then log in themselves. Failed logins are throttled, but
that does nothing about a password read straight off the wire. **Do not
port-forward this, and do not put it on a public host.** If you need it away
from home, put it behind a VPN such as WireGuard or Tailscale.

Running a points miner also violates the
[Twitch Terms of Service](https://www.twitch.tv/p/legal/terms-of-service/)
and can get the account it signs in as suspended. Use an account you are
willing to lose.

### Putting it behind a reverse proxy

A proxy such as Caddy, nginx or Traefik can terminate TLS in front of this
app, which fixes the plaintext problem — the password and session cookie stop
crossing the network in the clear. It does **not** turn this into something
safe to expose publicly. Access is still one shared password with no second
factor, and a public endpoint is reachable by people who guess passwords for
a living. **A VPN is still the better answer**; reach for a proxy when you
need real HTTPS on your own network, or when a VPN genuinely is not an
option.

If you do it, do it with both of these set (see `.env.example`):

    SECURE_COOKIE=1     # cookie never sent over plain HTTP
    TRUST_PROXY=1       # throttle sees real client IPs, not the proxy's

and bind the container to loopback so the proxy is the only way in — swap
the `ports:` entry in `compose.yaml` for:

    ports:
      - "127.0.0.1:8080:8080"

Without that last part the app is still listening on every interface, and
the proxy is a front door next to an open window.

Two things the app does for you, and one it does not:

- Failed logins are throttled per client address — ten wrong passwords buys
  a 15 minute lockout, so the password is not open to fast guessing.
- `SECURE_COOKIE=1` marks the session cookie `Secure`, so a browser will not
  send it over plain HTTP even if something later reaches the app by HTTP.
- There is still no second factor and no per-user accounts. If the password
  is guessed, the miner and its Twitch session are gone. Adding authentication
  at the proxy — basic auth, or an SSO forward-auth — puts a second lock in
  front of the first, and is worth doing if this is reachable from outside
  your network.

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
