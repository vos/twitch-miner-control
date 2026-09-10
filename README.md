<p align="center">
  <img src="docs/logo.png" alt="" width="240">
</p>

# Twitch Miner Control

A control panel for
[Twitch Channel Points Miner](https://github.com/mpforce1/Twitch-Channel-Points-Miner) —
a web UI to configure and control the miner, in place of editing `run.py`
by hand.

Add and reorder streamers, watch points accrue, sign in to Twitch with a
device code, and restart the miner — all from the browser. The miner
itself is vendored as a submodule and imported directly, so this project
tracks upstream rather than reimplementing it.

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
the `ports:` entry in your `compose.yaml` for:

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

Requires Docker with the Compose plugin. Nothing else — no clone, no
Node, no Python. The image is published to the GitHub Container Registry
and built for both `linux/amd64` and `linux/arm64`, so it runs on an
ordinary PC or server as well as on a Raspberry Pi 4/5 or Apple Silicon.

Make a directory to keep the app's data in, fetch the Compose file, and
start it:

    mkdir twitch-miner-control && cd twitch-miner-control
    curl -o compose.yaml https://raw.githubusercontent.com/vos/twitch-miner-control/main/compose.prod.yaml
    echo "APP_PASSWORD=choose-something" > .env
    docker compose up -d

Open http://localhost:8080, unlock with your password, then go to
**Twitch account** and sign in with the device code. Add streamers on the
**Streamers** screen and press **Apply & Restart**.

Config, point history and the Twitch cookies live in `./data`, next to the
Compose file and mounted into the container — back that up, and keep it out
of anywhere public, since the cookies are a signed-in Twitch session.

### Updating

`:latest` follows the newest release. Pull it and recreate the container;
your `./data` directory is untouched.

    docker compose pull
    docker compose up -d

To stay on a fixed version instead, replace `:latest` in your
`compose.yaml` with a release tag — `:1`, `:1.2` or `:1.2.3`. The
published tags are listed on the
[package page](https://github.com/vos/twitch-miner-control/pkgs/container/twitch-miner-control).

### Building the image yourself

Only needed if you want to change the code, or run a commit that has not
been published yet. The `--recurse-submodules` matters: the build imports
the vendored miner from `vendor/miner`, and without it the image builds
against an empty directory.

    git clone --recurse-submodules https://github.com/vos/twitch-miner-control.git
    cd twitch-miner-control
    echo "APP_PASSWORD=choose-something" > .env
    docker compose up -d

The checkout has its own `compose.yaml` with a `build:` section, so this
one compiles the image locally instead of pulling it — no download step,
and no relation to the file the quick start fetches. If you already cloned
without the submodule, `git submodule update --init` fixes it in place.

## How it works

A Fastify backend serves the API and the built frontend on one port, and
runs the miner as a Python child process it can stop and restart. The
React frontend talks to that API and polls for point updates.

- `apps/backend` — Fastify + SQLite (`better-sqlite3`), TypeScript.
- `apps/frontend` — React 19 + Mantine, built by Vite.
- `python/` — the miner entry point (`run.py`), config translation
  (`miner_config.py`) and helpers for login and state.
- `vendor/miner` — upstream, as a git submodule, imported directly.

### Notifications

The miner can push events to Telegram, Discord, Matrix, Pushover, Gotify or a
plain webhook. Those are deliberately **not** configurable from the web UI:
they carry bot tokens and webhook URLs, and this app serves a single shared
password over plain HTTP on your LAN. Set them by hand instead.

Edit the `LoggerSettings(...)` block in `python/run.py`:

    logger_settings=LoggerSettings(
        save=True,
        console_level=20,
        file_level=_file_level(),
        hooks=[DoorbellHook(DOORBELL_URL, DOORBELL_TOKEN)],
        telegram=Telegram(
            chat_id=123456789,
            token="123456789:your-bot-token",
            events=[Events.STREAMER_ONLINE, Events.BET_LOSE],
        ),
    ),

importing whichever integrations you use from
`TwitchChannelPointsMiner.classes` (`Telegram`, `Discord`, `Webhook`,
`Matrix`, `Pushover`, `Gotify`) and `Events` from
`TwitchChannelPointsMiner.classes.Settings`. Keep the existing `hooks=[...]`
entry: upstream appends the named integrations to that list rather than
replacing it, so the app's own event feed keeps working alongside yours.

Restart the miner from the dashboard to pick the change up.

**If you run the published image**, `run.py` lives inside it and your edit is
lost on the next `docker compose pull`. Copy the file out once and mount your
copy over it:

    docker compose cp twitch-miner-control:/app/python/run.py ./run.py

then add to your `compose.yaml`:

    volumes:
      - ./data:/data
      - ./run.py:/app/python/run.py:ro

Re-copy the file after an upgrade that changes `run.py` upstream, or your
pinned copy will keep overriding the new one.

## Development

Runs the backend and frontend directly, without Docker. Requires
Node 24+, [pnpm](https://pnpm.io) and [uv](https://docs.astral.sh/uv/) —
or the dev container below, which comes with all three preinstalled.

    git submodule update --init      # vendor/miner
    pnpm install
    uv sync                          # creates .venv the helpers run from
    cp .env.example .env             # then set APP_PASSWORD
    pnpm dev

Open the Vite URL it prints (http://localhost:5173), **not** port 8080 —
Vite serves the UI with hot reload and proxies `/api` to the backend.

`pnpm dev` runs three watchers, named after the tool each one runs:
`dev:tsc` recompiles the backend, `dev:node` restarts it, and `dev:web`
serves the frontend through Vite. Editing backend TypeScript restarts the
server automatically. Ctrl-C stops all three.

Dev mode reads its configuration from `.env` (see `.env.example` for
what each variable does) and keeps its data in `./.devdata`, so it never
touches the `./data` volume Docker mounts.

### Miner logs

The miner writes its own log file to `<data dir>/logs`, rotated daily
with seven days kept. `MINER_LOG_LEVEL` sets how much goes into it
(`DEBUG`, `INFO`, `WARNING`, `ERROR`, `CRITICAL`; default `INFO`) —
upstream's own default is `DEBUG`, which is mostly websocket keepalives
and connection chatter and reached 267MB in a day. Set it to `DEBUG`
while diagnosing a miner problem, then put it back.

This is separate from the **Logs** page in the UI, which shows the
miner's console output and is not affected by this setting.

### Using the dev container

`.devcontainer/` describes a ready-made environment, so you do not have to
put the toolchain on your own machine. In VS Code with the Dev Containers
extension, open the cloned repository and choose **Reopen in Container** —
or use any other editor that reads `devcontainer.json`.

It is built on `node:24` and ships:

- Node 24, and pnpm through corepack — so the version follows the
  `packageManager` pin in `package.json` rather than whatever happens to
  be installed globally.
- [uv](https://docs.astral.sh/uv/) with CPython 3.12 already fetched. The
  Debian base only carries 3.11, and `pyproject.toml` requires >=3.12.
- `git`, `gh`, `jq`, `zsh` as the default shell, and the Claude Code CLI.

The repository is bind-mounted at `/workspace`, so edits appear on the
host immediately and commits are ordinary local commits. VS Code forwards
the ports, so the Vite URL opens on the host as usual.

What it installs is the toolchain, not this project's dependencies: there
is no `postCreateCommand`, so run the same setup steps above once inside
the container before `pnpm dev`.

It deliberately has no Docker in it. Building the image and running
`docker compose` — `scripts/smoke.sh` included — have to happen on the
host.

## Testing

    pnpm test        # backend and frontend, via vitest
    uv run pytest    # the Python helpers and the upstream contract test

`scripts/smoke.sh` starts the stack and checks it answers, for when you
want to know the whole thing boots rather than that the units pass.

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
