# syntax=docker/dockerfile:1

# --- Stage 1: build the pnpm workspace (backend dist + frontend dist) -----
FROM node:24-slim AS web
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build
# `pnpm -r build` leaves apps/backend/node_modules full of symlinks such as
# `fastify -> ../../../node_modules/.pnpm/fastify@.../node_modules/fastify`,
# resolved relative to the pnpm workspace root three levels up. Copying that
# directory alone into the final stage (as a naive `COPY apps/backend/dist` +
# `COPY apps/backend/node_modules` would do) ships dangling symlinks, because
# the final stage has no workspace root to resolve them against -- the
# process would fail to `require`/`import` fastify, better-sqlite3, zod, or
# either @fastify/* package at startup. `pnpm deploy` produces a
# self-contained deployment directory: its own node_modules/.pnpm store with
# only production dependencies, addressed by symlinks that stay inside that
# same directory, so it survives being copied anywhere.
RUN pnpm --filter @app/backend deploy --prod /build/deploy/backend

# --- Stage 2: runtime (Python helpers + miner + the built Node backend) ---
FROM python:3.12-slim
WORKDIR /app

# python:3.12-slim's `nodejs` apt package tracks Debian bookworm's own
# nodejs (18.20.x at the time of writing), not the Node 22 the backend was
# built and pnpm-deployed against; better-sqlite3's native addon is compiled
# for a specific Node ABI (NODE_MODULE_VERSION), so running it under a
# different Node major would fail to load at startup. Copying the actual
# `node` binary out of the `web` build stage keeps the runtime Node version
# identical to the one the addon was built for. Both base images track
# Debian bookworm, so the binary's dynamic-library requirements (glibc,
# libstdc++) are already satisfied; libatomic1 is the one additional runtime
# dependency the official Node bookworm-slim image installs for itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libatomic1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml uv.lock ./
# vendor/miner is a git submodule pinned to an explicit commit (see
# .gitmodules); it must be checked out (`git submodule update --init`)
# before this Dockerfile is built, the same way any other tracked file must
# exist before `docker build` can COPY it. It is not a uv dependency (no
# [tool.uv.sources] entry references it) -- it is put on PYTHONPATH at
# runtime instead, by both `python/run.py` and the Node backend's
# `helperEnv()` -- so its placement relative to `uv sync` does not matter,
# only that it ends up at vendor/miner under WORKDIR.
COPY vendor/miner vendor/miner
RUN uv sync --frozen --no-dev

COPY python python
COPY --from=web /build/deploy/backend/dist apps/backend/dist
COPY --from=web /build/deploy/backend/node_modules apps/backend/node_modules
COPY --from=web /build/apps/frontend/dist public

# MINER_DIR is set explicitly even though the backend's fallback --
# PYTHON_DIR/../vendor/miner -- already lands on /app/vendor/miner here.
# That fallback makes the miner's location a silent consequence of where
# the Python helpers live, so moving PYTHON_DIR alone would send
# PYTHONPATH at a directory this image never populated, and the miner
# would fail to import only once someone pressed Start. Naming the path
# the COPY above actually wrote keeps the two independent.
ENV DATA_DIR=/data \
    PYTHON_DIR=/app/python \
    PYTHON_BIN=/app/.venv/bin/python \
    MINER_DIR=/app/vendor/miner \
    STATIC_ROOT=/app/public \
    PORT=8080
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "apps/backend/dist/index.js"]
