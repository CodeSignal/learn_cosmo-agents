# Draft runtime image for the simulation. Locally it starts from Ubuntu; on the platform the
# first stage's base becomes the platform's base image (which already has the session user).
#
#   docker build -f image/Dockerfile -t cosmo-agents:dev .

FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY client ./client
RUN npm run build

# Agent UIs: the vendored OpenCode workspace (UI kit, OpenCosmo) with our apps composed in as
# packages, built with the Bun version upstream pins.
FROM oven/bun:1.3.14 AS ui
WORKDIR /work
COPY vendor/opencode ./
COPY apps/cosmodex ./packages/cosmodex
COPY apps/cosmo-code ./packages/cosmo-code
RUN bun install --filter "@opencode-ai/app" --filter "@cosmo/cosmodex" --filter "@cosmo/cosmo-code" --frozen-lockfile
RUN cd packages/app && OPENCOSMO_BASE=/agents/opencosmo/ VITE_ENGINE_PATH=/engine/opencosmo VITE_WORKSPACE=/usercode/FILESYSTEM OPENCODE_CHANNEL=prod bun run build
RUN cd packages/cosmodex && COSMODEX_BASE=/agents/cosmodex/ VITE_ENGINE_PATH=/engine/cosmodex VITE_WORKSPACE=/usercode/FILESYSTEM bun run build
RUN cd packages/cosmo-code && COSMO_CODE_BASE=/agents/cosmo-code/ VITE_ENGINE_PATH=/engine/cosmo-code VITE_WORKSPACE=/usercode/FILESYSTEM bun run build

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

# The simulation, root-owned so neither the session user nor the agentsim user can change it.
COPY package.json /opt/agentsim/package.json
COPY server /opt/agentsim/server
COPY policy /opt/agentsim/policy
COPY root /opt/agentsim/root
COPY scripts /opt/agentsim/scripts
# Cosmo Code's engine host and its pinned Agent SDK (the engine itself is the pinned claude above).
COPY engines /opt/agentsim/engines
RUN cd /opt/agentsim/engines/claude-host && npm ci --omit=optional --no-fund --no-audit
COPY --from=build /src/dist /opt/agentsim/dist
COPY --from=ui /work/packages/app/dist /opt/agentsim/dist-agents/opencosmo
COPY --from=ui /work/packages/cosmodex/dist /opt/agentsim/dist-agents/cosmodex
COPY --from=ui /work/packages/cosmo-code/dist /opt/agentsim/dist-agents/cosmo-code
RUN mkdir -p /opt/agentsim/bin \
    && mv /opt/agentsim/root/bin/* /opt/agentsim/bin/ && rmdir /opt/agentsim/root/bin \
    && install -m 0440 -o root -g root /opt/agentsim/root/sudoers /etc/sudoers.d/agentsim \
    && rm /opt/agentsim/root/sudoers \
    && visudo -cf /etc/sudoers.d/agentsim \
    && chown -R root:root /opt/agentsim && chmod -R go-w /opt/agentsim \
    && chmod 0755 /opt/agentsim/bin/* /opt/agentsim/scripts/* \
    && mkdir -p /var/lib/agentsim/home && chown agentsim:agentsim /var/lib/agentsim/home

WORKDIR /usercode/FILESYSTEM
