#!/bin/sh
set -eu

if [ -z "$(git config --global user.name || true)" ]; then
  git config --global user.name "${GITQUIRE_GIT_NAME:-GitQuire}"
fi
if [ -z "$(git config --global user.email || true)" ]; then
  git config --global user.email "${GITQUIRE_GIT_EMAIL:-gitquire@localhost}"
fi

if [ -n "${GITHUB_APP_ID:-}" ]; then
  echo "[entrypoint] Syncing /data with ${GITQUIRE_REPO:-<GITQUIRE_REPO unset>} through the GitHub App"
  gitquire gitquire-bootstrap /data
elif [ ! -d /data/.ok ]; then
  echo "[entrypoint] /data is not initialized. Running gitquire init"
  gitquire init < /dev/null
fi

exec gitquire start
