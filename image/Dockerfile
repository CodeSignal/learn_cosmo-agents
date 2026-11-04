# Runtime image for the simulation. Locally it starts from Ubuntu; on the platform the final
# stage's base becomes the platform's base image (which already has the session user).
#
#   docker build -f image/Dockerfile -t cosmo-agents:dev .          the image
#   docker build -f image/Dockerfile --target release -o out .      just out/release.tar.gz

# Agent UIs: the vendored OpenCode workspace (UI kit, OpenCosmo) with our apps composed in as
# packages, built with the Bun version upstream pins.
FROM oven/bun:1.3.14 AS ui
WORKDIR /work
COPY vendor/opencode ./
COPY apps/cosmodex ./packages/cosmodex
COPY apps/cosmo-code ./packages/cosmo-code
RUN bun install --filter "@opencode-ai/app" --filter "@cosmo/cosmodex" --filter "@cosmo/cosmo-code" --frozen-lockfile
RUN cd packages/app && OPENCOSMO_BASE=/_cosmo/agents/opencosmo/ VITE_ENGINE_PATH=/_cosmo/engine/opencosmo VITE_COSMO=/_cosmo VITE_WORKSPACE=/usercode/FILESYSTEM OPENCODE_CHANNEL=prod bun run build
RUN cd packages/cosmodex && COSMODEX_BASE=/_cosmo/agents/cosmodex/ VITE_ENGINE_PATH=/_cosmo/engine/cosmodex VITE_COSMO=/_cosmo VITE_WORKSPACE=/usercode/FILESYSTEM bun run build
RUN cd packages/cosmo-code && COSMO_CODE_BASE=/_cosmo/agents/cosmo-code/ VITE_ENGINE_PATH=/_cosmo/engine/cosmo-code VITE_COSMO=/_cosmo VITE_WORKSPACE=/usercode/FILESYSTEM bun run build

# bwrap for user mode (the platform's standard image has none and setup has no root to install
# it): the binary from Ubuntu 22.04's package, which matches that image's libraries.
FROM ubuntu:22.04 AS bwrap
RUN apt-get update && cd /tmp && apt-get download bubblewrap && dpkg -x bubblewrap_*.deb /out \
    && cp /out/usr/share/doc/bubblewrap/copyright /out/bwrap.copyright

# The release tarball (scripts/pack-release.mjs): the shell, the bundled server and helpers, the UIs.
FROM node:22-bookworm AS pack
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY engines/claude-host/package.json engines/claude-host/package-lock.json ./engines/claude-host/
COPY vite.config.js LICENSE NOTICE ./
COPY client ./client
RUN npm run build
COPY server ./server
COPY policy ./policy
COPY root ./root
COPY scripts ./scripts
COPY engines/claude-host/host.mjs ./engines/claude-host/
COPY --from=ui /work/packages/app/dist ./dist-agents/opencosmo
COPY --from=ui /work/packages/cosmodex/dist ./dist-agents/cosmodex
COPY --from=ui /work/packages/cosmo-code/dist ./dist-agents/cosmo-code
COPY --from=bwrap /out/usr/bin/bwrap /out/bwrap.copyright ./vendor/
RUN node scripts/pack-release.mjs

FROM scratch AS release
COPY --from=pack /src/release.tar.gz /

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg sudo bubblewrap socat git python3 procps jq \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# The session user (the agent's tools run as this user) and the simulation's own user.
RUN id runner >/dev/null 2>&1 || useradd -m -s /bin/bash runner; \
    useradd --system --home-dir /var/lib/agentsim/home --shell /usr/sbin/nologin agentsim; \
    mkdir -p /usercode/FILESYSTEM && chown runner:runner /usercode/FILESYSTEM

# Pinned engines, straight from the pin table.
COPY policy/pins.json /tmp/pins.json
RUN npm install -g --no-fund --no-audit $(node -e 'const p=require("/tmp/pins.json");console.log(Object.values(p.engines).map(e=>e.package+"@"+e.version).join(" "))') \
    && rm /tmp/pins.json

# The simulation from its release tarball, root-owned so neither the session user nor the agentsim
# user can change it. Cosmo Code's engine host gets its pinned Agent SDK from npm, like the engines
# (the engine itself is the pinned claude above).
COPY --from=pack /src/release.tar.gz /tmp/release.tar.gz
RUN mkdir -p /opt/agentsim && tar -xzf /tmp/release.tar.gz -C /opt/agentsim && rm /tmp/release.tar.gz \
    && cd /opt/agentsim/engines/claude-host && npm ci --omit=optional --no-fund --no-audit \
    && sh /opt/agentsim/install.sh

WORKDIR /usercode/FILESYSTEM
