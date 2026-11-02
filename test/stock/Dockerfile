# A stand-in for the platform's standard task image, as a setup-time probe found it: Ubuntu 22.04,
# Node 24 under /root/.nvm (npm's global prefix writable through the root group), the session
# user runner (uid 10000) in the root group, no sudo, and no bwrap, socat or jq.
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl wget git python3 xz-utils \
    && rm -rf /var/lib/apt/lists/*
ARG NODE=24
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
    && v=$(curl -fsSL https://nodejs.org/dist/latest-v${NODE}.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-linux-$arch.tar.xz" | head -1) \
    && mkdir -p /root/.nvm/versions/node/v${NODE} \
    && curl -fsSL "https://nodejs.org/dist/latest-v${NODE}.x/$v" | tar -xJ --strip-components=1 -C /root/.nvm/versions/node/v${NODE} \
    && chown -R root:root /root/.nvm && chmod 750 /root && chmod -R g+rwX /root/.nvm
ENV PATH=/root/.nvm/versions/node/v24/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN useradd -m -u 10000 -G root -s /bin/bash runner \
    && mkdir -p /usercode/FILESYSTEM/.codesignal && chmod 1777 /usercode/FILESYSTEM /usercode/FILESYSTEM/.codesignal
USER runner
WORKDIR /usercode/FILESYSTEM
