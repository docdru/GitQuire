# GitQuire server image, built from this repository's source.
#
# Stage 1 builds the cli package (server + web app) and packs
# it as an npm tarball. Stage 2 installs that tarball on a slim Node image.
#
#   docker build -t gitquire:local .
#   docker run --rm -p 8080:8080 -e GITQUIRE_ALLOW_EXTERNAL=1 -v gitquire-data:/data gitquire:local

ARG NODE_VERSION=24.21.0

# ---------------------------------------------------------------- build ----
FROM node:${NODE_VERSION}-bookworm AS build

ENV CI=1

# pnpm version comes from package.json "packageManager".
RUN npm install -g corepack@latest && corepack enable

WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/app/package.json packages/app/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY docs/package.json docs/

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

RUN node scripts/create-turbo-cache-key.mjs \
 && node packages/app/scripts/compile-i18n-catalogs.ts --best-effort
RUN cd packages/app && pnpm run i18n:compile
RUN pnpm exec turbo run build --filter=@gitquire/cli
RUN mkdir -p /out && cd packages/cli && pnpm pack --pack-destination /out \
 && mv /out/*.tgz /out/gitquire.tgz

# -------------------------------------------------------------- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim

# git is a hard boot requirement: the server runs a git preflight at boot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/gitquire.tgz /tmp/gitquire.tgz
RUN npm install -g /tmp/gitquire.tgz && rm /tmp/gitquire.tgz && gitquire --version

# PORT is the platform-injection contract (Railway, Fly, Cloud Run override it).
# GITQUIRE_BIND=0.0.0.0 makes the listener reachable from the container network.
# Exposure consent (GITQUIRE_ALLOW_EXTERNAL=1) is deliberately not baked in: a run
# without it refuses to boot and names the fix.
# GITQUIRE_FILE_WATCHER_BACKEND=off: changes reach the server through GitQuire itself
# (the editor, sync, drafts, agents); a direct edit on the volume needs a re-read.
ENV PORT=8080 \
    GITQUIRE_BIND=0.0.0.0 \
    GITQUIRE_FILE_WATCHER_BACKEND=off

# Mount a persistent volume at /data. It holds the project (a git working copy).
WORKDIR /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
