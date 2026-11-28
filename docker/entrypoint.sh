#!/bin/sh
set -eu

if [ -z "$(git config --global user.name || true)" ]; then
  git config --global user.name "${GITQUIRE_GIT_NAME:-GitQuire}"
fi
if [ -z "$(git config --global user.email || true)" ]; then
  git config --global user.email "${GITQUIRE_GIT_EMAIL:-gitquire@localhost}"
fi

exec gitquire front-door /data
