# GitQuire server image, built from this repository's source.
#
# Stage 1 builds the cli package (server + web app) and packs
# it as an npm tarball. Stage 2 installs that tarball on a slim Node image.
#
#   docker build -t gitquire:local .
#   docker run --rm -p 8080:8080 -e OK_ALLOW_EXTERNAL=1 -v gitquire-data:/data gitquire:local

ARG NODE_VERSION=24.21.0

# ---------------------------------------------------------------- build ----
FROM node:${NODE_VERSION}-bookworm AS build

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    CI=1

# pnpm version comes from package.json "packageManager".
RUN npm install -g corepack@latest && corepack enable

WORKDIR /src
COPY . .

RUN pnpm install --frozen-lockfile

RUN cd packages/app && pnpm run i18n:compile
RUN pnpm exec turbo run build --filter=@inkeep/open-knowledge
RUN mkdir -p /out && cd packages/cli && pnpm pack --pack-destination /out \
 && mv /out/*.tgz /out/gitquire.tgz

# -------------------------------------------------------------- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim

# git is a hard boot requirement: the server runs a git preflight at boot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/gitquire.tgz /tmp/gitquire.tgz
RUN npm install -g /tmp/gitquire.tgz && rm /tmp/gitquire.tgz && ok --version

# PORT is the platform-injection contract (Railway, Fly, Cloud Run override it).
# OK_BIND=0.0.0.0 makes the listener reachable from the container network.
# Exposure consent (OK_ALLOW_EXTERNAL=1) is deliberately not baked in: a run
# without it refuses to boot and names the fix.
ENV PORT=8080 \
    OK_BIND=0.0.0.0

# Mount a persistent volume at /data. It holds the project (a git working copy).
WORKDIR /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
