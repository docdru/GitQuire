#!/bin/sh
set -eu

if [ -z "$(git config --global user.name || true)" ]; then
  git config --global user.name "${GITQUIRE_GIT_NAME:-GitQuire}"
fi
if [ -z "$(git config --global user.email || true)" ]; then
  git config --global user.email "${GITQUIRE_GIT_EMAIL:-gitquire@localhost}"
fi

wikis=$(printf '%s' "${GITQUIRE_WIKIS:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
case "$wikis" in
  1|on|true|yes)
    echo "[entrypoint] Several wikis: starting the front door on /data"
    exec gitquire front-door /data
    ;;
  ''|0|off|false|no)
    ;;
  *)
    echo "[entrypoint] GITQUIRE_WIKIS must be on or off, got \"${GITQUIRE_WIKIS}\"" >&2
    exit 78
    ;;
esac

for marker in server/wikis.json .gitquire-moving-in .gitquire-moving-back; do
  if [ "$marker" = server/wikis.json ] && [ -e /data/.git ]; then
    continue
  fi
  if [ -e "/data/$marker" ]; then
    echo "[entrypoint] /data holds several wikis or an unfinished move (/data/$marker). Start it with GITQUIRE_WIKIS=on; an interrupted move cannot be finished any more: start on a new, empty volume." >&2
    exit 78
  fi
done

if [ -n "${GITHUB_APP_ID:-}" ]; then
  echo "[entrypoint] Syncing /data with ${GITQUIRE_REPO:-<GITQUIRE_REPO unset>} through the GitHub App"
  gitquire gitquire-bootstrap /data
elif [ "${GITQUIRE_HOST:-}" = "forgejo" ]; then
  echo "[entrypoint] Syncing /data with ${GITQUIRE_REPO:-<GITQUIRE_REPO unset>} on Forgejo"
  gitquire gitquire-bootstrap /data
elif [ ! -d /data/.gitquire ] && [ ! -d /data/.ok ]; then
  echo "[entrypoint] /data is not initialized. Running gitquire init"
  gitquire init < /dev/null
fi

exec gitquire start
