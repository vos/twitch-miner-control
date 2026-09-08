FROM node:24

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/node/.claude && \
  chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -x

# Install Claude
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Enable corepack so pnpm is on PATH. node:24 ships corepack but leaves it
# disabled, so without this there's no pnpm shim at all. corepack reads the
# `packageManager` pin in package.json and fetches that exact version on
# first use, which is why we deliberately don't `npm install -g pnpm` -- that
# would install a second, unpinned copy that shadows the pinned one.
#
# --install-directory is required: corepack defaults to writing its shims
# next to its own binary in root-owned /usr/local/bin, which fails with
# EACCES as the node user. NPM_CONFIG_PREFIX/bin is chowned to node above
# and already on PATH.
RUN mkdir -p "${NPM_CONFIG_PREFIX}/bin" \
  && corepack enable --install-directory "${NPM_CONFIG_PREFIX}/bin"

# `corepack enable` only installs stub shims; the real pnpm is fetched on
# first use, which otherwise stops at an interactive "Do you want to
# continue?" prompt. Disable that prompt for good, and warm the cache at
# build time so the first `pnpm install` doesn't wait on a download.
#
# PNPM_VERSION must track the `packageManager` pin in package.json. We can't
# read that file here -- the build context is .devcontainer/, not the repo
# root -- but a drift is harmless: corepack honours the pin at runtime and
# just re-downloads, so the stale prefetch costs a download, not a failure.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ARG PNPM_VERSION=9.15.9
RUN corepack install --global "pnpm@${PNPM_VERSION}"

# Install uv, and let it provide the Python the project needs. The node:24
# base is Debian bookworm, whose system Python is 3.11 -- older than the
# >=3.12 in pyproject.toml -- so uv downloads its own interpreter rather
# than relying on the distro's.
ARG UV_VERSION=0.9.5
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh
ENV PATH=/home/node/.local/bin:$PATH

# Pre-fetch the interpreter so the first `uv sync` doesn't pay for it. Keep
# this in step with the repo's .python-version; uv would fetch the right one
# on demand anyway, so a drift here costs a download, not a broken build.
ARG PYTHON_VERSION=3.12
RUN uv python install "${PYTHON_VERSION}"


# Copy and set up firewall script
#COPY init-firewall.sh /usr/local/bin/
#USER root
#RUN chmod +x /usr/local/bin/init-firewall.sh && \
#  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" > /etc/sudoers.d/node-firewall && \
#  chmod 0440 /etc/sudoers.d/node-firewall
#USER node

