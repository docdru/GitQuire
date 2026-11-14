#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE:?IMAGE (the GitQuire image to test) is required}"
: "${TEST_REPO:?TEST_REPO (owner/name of the throwaway test repository) is required}"
: "${TEST_BRANCH:?TEST_BRANCH (a branch name this run may create and delete) is required}"
: "${APP_ID:?APP_ID (the test GitHub App id) is required}"
: "${APP_PRIVATE_KEY:?APP_PRIVATE_KEY (the test GitHub App private key, PEM) is required}"
: "${GH_TOKEN:?GH_TOKEN (an installation token of the test App) is required}"
export GH_TOKEN

CONTAINER="${CONTAINER:-gq-sync}"
VOLUME="${VOLUME:-gq-sync-data}"
PORT="${PORT:-8090}"
WAIT_SECONDS="${WAIT_SECONDS:-150}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"

step() { printf '\n== %s\n' "$*"; }
fail() {
  printf '\nFAIL: %s\n' "$*" >&2
  exit 1
}

api() { gh api -H 'X-GitHub-Api-Version: 2022-11-28' "$@"; }

remote_file() {
  api "repos/${TEST_REPO}/contents/$1?ref=${TEST_BRANCH}" -H 'Accept: application/vnd.github.raw' 2>/dev/null
}

put_remote_file() {
  local path="$1" content="$2" message="$3" sha
  sha="$(api "repos/${TEST_REPO}/contents/${path}?ref=${TEST_BRANCH}" --jq .sha 2>/dev/null || true)"
  local args=(-X PUT "repos/${TEST_REPO}/contents/${path}"
    -f "message=${message}" -f "branch=${TEST_BRANCH}"
    -f "content=$(printf '%s' "$content" | base64 -w0)")
  if [ -n "$sha" ]; then args+=(-f "sha=${sha}"); fi
  api "${args[@]}" --jq .commit.sha
}

local_file() { docker exec "$CONTAINER" cat "/data/$1" 2>/dev/null; }

write_local_file() {
  printf '%s' "$2" | docker exec -i "$CONTAINER" sh -c "mkdir -p \"\$(dirname '/data/$1')\" && cat > '/data/$1'"
}

trigger_sync() {
  docker exec "$CONTAINER" curl -fsS -X POST -H 'Content-Type: application/json' \
    -d "{\"op\":\"${1:-sync}\"}" "http://127.0.0.1:8080/api/sync/trigger" >/dev/null
}

sync_status() { docker exec "$CONTAINER" curl -fsS "http://127.0.0.1:8080/api/sync/status"; }

wait_until() {
  local what="$1"
  shift
  local deadline=$((SECONDS + WAIT_SECONDS))
  until "$@"; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "--- sync status"
      sync_status || true
      fail "timed out after ${WAIT_SECONDS}s waiting for: ${what}"
    fi
    trigger_sync || true
    sleep 5
  done
  echo "ok: ${what}"
}

contains() { grep -qF -- "$2" <<<"$1"; }
local_has() { contains "$(local_file "$1" || true)" "$2"; }
remote_has() { contains "$(remote_file "$1" || true)" "$2"; }

start_container() {
  docker run -d --name "$CONTAINER" -p "127.0.0.1:${PORT}:8080" \
    -v "${VOLUME}:/data" \
    -e OK_ALLOW_EXTERNAL=1 \
    -e GITHUB_APP_ID="$APP_ID" \
    -e GITHUB_APP_PRIVATE_KEY="$APP_PRIVATE_KEY" \
    -e GITQUIRE_REPO="$TEST_REPO" \
    -e GITQUIRE_BRANCH="$TEST_BRANCH" \
    -e GITQUIRE_GIT_NAME="GitQuire sync test" \
    -e GITQUIRE_GIT_EMAIL="sync-test@gitquire.invalid" \
    "$IMAGE" >/dev/null
  local deadline=$((SECONDS + 180))
  until curl -fsS "http://127.0.0.1:${PORT}/readyz" >/dev/null 2>&1; do
    if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
      docker logs "$CONTAINER" || true
      fail "the container exited during start-up"
    fi
    [ "$SECONDS" -lt "$deadline" ] || fail "the server was not ready within 180s"
    sleep 2
  done
}

stop_container() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }

step "Start GitQuire against ${TEST_REPO}@${TEST_BRANCH}"
start_container
local_file README.md >/dev/null || fail "the clone has no README.md (the test branch starts from the default branch)"
echo "ok: cloned through the GitHub App"

step "Pull: a commit made on GitHub reaches the editor"
put_remote_file "sync-test/pull-${STAMP}.md" "# Pulled ${STAMP}"$'\n' "sync test: remote commit ${STAMP}" >/dev/null
wait_until "remote page appears in /data" local_has "sync-test/pull-${STAMP}.md" "Pulled ${STAMP}"

step "Push: a page changed in the editor reaches GitHub"
write_local_file "sync-test/push-${STAMP}.md" "# Pushed ${STAMP}"$'\n'
wait_until "local page appears on GitHub" remote_has "sync-test/push-${STAMP}.md" "Pushed ${STAMP}"
author="$(api "repos/${TEST_REPO}/commits?sha=${TEST_BRANCH}&path=sync-test/push-${STAMP}.md&per_page=1" --jq '.[0].commit.author.name')"
echo "pushed commit author: ${author}"
[ -n "$author" ] || fail "the pushed commit has no author"

step "Both sides at once: different pages changed on GitHub and in the editor"
put_remote_file "sync-test/both-remote-${STAMP}.md" "remote side ${STAMP}"$'\n' "sync test: concurrent remote ${STAMP}" >/dev/null
write_local_file "sync-test/both-local-${STAMP}.md" "local side ${STAMP}"$'\n'
wait_until "remote change pulled" local_has "sync-test/both-remote-${STAMP}.md" "remote side ${STAMP}"
wait_until "local change pushed" remote_has "sync-test/both-local-${STAMP}.md" "local side ${STAMP}"

step "Sync status is healthy"
status="$(sync_status)"
echo "$status"
python3 - "$status" <<'PY'
import json, sys
s = json.loads(sys.argv[1])
problems = []
if not s.get("hasRemote"):
    problems.append("no remote")
if not s.get("syncEnabled"):
    problems.append("sync is off")
for key in ("pushError", "pullError", "pausedReason"):
    if s.get(key):
        problems.append(f"{key}: {s[key]}")
if s.get("conflictCount", 0):
    problems.append(f"{s['conflictCount']} conflicts")
permission = s.get("pushPermission")
if isinstance(permission, dict) and permission.get("checkStatus") == "denied":
    problems.append(f"push permission denied: {permission}")
if problems:
    sys.exit("unhealthy sync status: " + "; ".join(problems))
print("ok: sync status healthy")
PY

step "The App can read pull requests"
pulls="$(docker exec "$CONTAINER" curl -fsS "http://127.0.0.1:8080/api/gitquire/pulls")"
echo "$pulls"
contains "$pulls" '"configured":true' || fail "GET /api/gitquire/pulls did not use the GitHub App"

step "Restart: the volume keeps the checkout and sync resumes with a fresh token"
stop_container
start_container
put_remote_file "sync-test/after-restart-${STAMP}.md" "after restart ${STAMP}"$'\n' "sync test: after restart ${STAMP}" >/dev/null
wait_until "remote change pulled after restart" local_has "sync-test/after-restart-${STAMP}.md" "after restart ${STAMP}"
write_local_file "sync-test/after-restart-local-${STAMP}.md" "local after restart ${STAMP}"$'\n'
wait_until "local change pushed after restart" remote_has "sync-test/after-restart-local-${STAMP}.md" "local after restart ${STAMP}"

printf '\nAll sync checks passed.\n'
