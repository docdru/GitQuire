# One mode, one way to describe a host

The owner's plan is the project doc `claude/gitquire-plan-one-mode.md` (written 2026-11-27 from `main` at `679cd3b`). This file holds the plan in short, the requirements, the stage 0 findings, the design as built and the choices made on the owner's behalf. Pull requests go into the feature branch `one-mode`; the owner merges `one-mode` into `main`.

## The plan in short

- **One mode.** The container is always the front door. `GITQUIRE_WIKIS` and the single-wiki server go away.
- **One way to describe a host.** `GITQUIRE_HOSTS` lists every host; each is described by `GITQUIRE_HOST_<KEY>_…`. There is no first host.
- **Wikis are added in the app.** `GITQUIRE_REPO` goes away.
- **No migration of single-wiki volumes.** Such a volume is refused with a clear message; the owner starts fresh. The moving code is deleted.
- **An old setting never fails silently:** GitQuire stops and names the new variable.
- With it, a clean-up of everything that only existed for the second mode or for older names.

### Decided by the owner (2026-11-27)

Several wikis always on, no switch. Host settings do not depend on any mode. `GITQUIRE_BRANCH` dropped: a wiki follows its repository's default branch. Single-wiki volumes are not migrated; `gitquire wikis adopt` and `unadopt` and their code are removed. Scalability work runs in parallel on `main`. The run is unattended. No backward compatibility yet. Only the owner merges into `main`.

### Recommended, not yet confirmed (built as written)

- Running without sign-in is dropped; a **set-up page** takes its place when no host is configured.
- Old variables are **refused at start**, all at once, each with its replacement.
- `GITQUIRE_ALLOW_EXTERNAL` is removed; the image always accepts connections.
- `GITQUIRE_SYNC_MODE` is removed from the environment (Wiki administration does not offer it per wiki, so it goes entirely).
- Old names (`OK_*`, `ok`, `open-knowledge`, `.ok/`): compatibility removed.
- `GITQUIRE_MCP_CONNECTORS` stays a switch.
- The version bump to the next middle number is prepared and left open.

### Settings after the change

```env
GITQUIRE_EXTERNAL_URL=https://wiki.example.org
GITQUIRE_SESSION_SECRET=…
GITQUIRE_HOSTS=github,forgejo
GITQUIRE_HOST_GITHUB_CLIENT_ID=…
GITQUIRE_HOST_GITHUB_CLIENT_SECRET=…
GITQUIRE_HOST_GITHUB_APP_ID=…
GITQUIRE_HOST_GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/app.pem
GITQUIRE_HOST_GITHUB_ALLOWED_OWNERS=team
GITQUIRE_HOST_GITHUB_ADMINS=alice
GITQUIRE_HOST_FORGEJO_URL=https://git.example.org
GITQUIRE_HOST_FORGEJO_CLIENT_ID=…
GITQUIRE_HOST_FORGEJO_CLIENT_SECRET=…
GITQUIRE_HOST_FORGEJO_TOKEN=…
GITQUIRE_HOST_FORGEJO_ALLOWED_OWNERS=team
GITQUIRE_HOST_FORGEJO_ADMINS=alice
```

A key that is `github` or `forgejo` is also the kind. Keys, addresses (`/w/<key>/…`, `/mcp/<key>`, `/auth/<key>/callback`), person ids and folders stay as they are, so a several-wikis volume needs no data move. `_ALLOWED_OWNERS` is required for every host. Every secret also as `_FILE`.

### Old to new

| Old | New |
| --- | --- |
| `GITQUIRE_WIKIS` | removed (always on) |
| `GITQUIRE_REPO` | removed; wikis are added in the app |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | `GITQUIRE_HOST_GITHUB_CLIENT_ID`, `_CLIENT_SECRET` |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_PRIVATE_KEY_FILE` | `GITQUIRE_HOST_GITHUB_APP_ID`, `_APP_PRIVATE_KEY`, `_APP_PRIVATE_KEY_FILE` |
| `GITQUIRE_GITHUB_WEB_URL`, `GITQUIRE_GITHUB_API_URL` | `GITQUIRE_HOST_GITHUB_URL`, `_API_URL` |
| `GITQUIRE_HOST=forgejo`, `GITQUIRE_HOST_URL`, `_API_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_TOKEN` | `forgejo` in `GITQUIRE_HOSTS`; `GITQUIRE_HOST_FORGEJO_URL`, `_API_URL`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_TOKEN` |
| `GITQUIRE_HOST_REPO_TOKEN` | removed; a server administrator enters each wiki's token in the app |
| `GITQUIRE_ADMINS`, `GITQUIRE_ALLOWED_OWNERS` | `GITQUIRE_HOST_<KEY>_ADMINS`, `_ALLOWED_OWNERS` |
| `GITQUIRE_COMMIT_EMAIL_FORMAT` | `GITQUIRE_HOST_<KEY>_COMMIT_EMAIL_FORMAT` |
| `GITQUIRE_ALLOWED_USERS`, `GITQUIRE_MCP_TOKEN`, `GITQUIRE_AUTH`, `GITQUIRE_BRANCH`, `GITQUIRE_SYNC_MODE`, `GITQUIRE_DRAFTS_DIR`, `GITQUIRE_ALLOW_EXTERNAL` | removed |

### Other changes of the same kind

C1 start summary per host in the log (never a secret). C2 administrators and allowed owners the host does not know are warned about at start. C3 a value with a trailing comment is refused. C4 a sample env file `deploy/gitquire.env.example`. C5 every environment variable the code reads is documented or removed, checked in CI (`GITQUIRE_TEST_*` exempt). C6 old-name compatibility removed (`OK_*`, `ok`, `open-knowledge`, `.ok/`). C7 leftover names (`open-knowledge-server`, `.okignore`). C8 one session cookie form. C9 DEPLOY.md as one path.

## Requirements

| # | Requirement |
| --- | --- |
| O1 | A several-wikis volume made by today's `main` starts with only the variables renamed: every wiki, token, agent token, per-person file and draft is found again; nothing is moved |
| O2 | A single-wiki volume is never taken over, cloned over or written to: the start stops first and says what to do |
| O3 | No removed variable is silently ignored; no renamed variable keeps a meaning under its old name |
| O4 | No route reaches a wiki without the host's access check. With the single-wiki gate, `GITQUIRE_ALLOWED_USERS`, `GITQUIRE_MCP_TOKEN` and `GITQUIRE_AUTH` gone, nothing may remain that lets a request in on a local rule |
| O5 | An editor process answers only with the internal secret, whoever starts it; it cannot be started as a public server |
| O6 | A host's secrets go only to that host's address after the renaming, `_FILE` forms included (S4) |
| O7 | The set-up page and the start summary show no secret and no wiki name |
| O8 | Nothing test-only in the published image |
| O9 | R1–R18, S1–S9 and P1–P12 of the earlier plans still hold; the review map is updated in the pull request that changes what it describes |

## Blocks

| # | Block | Review | Pull request | State |
| --- | --- | --- | --- | --- |
| B0 | Branch and stage 0 (this file) | | | |
| B3 | Remove moving over (done before B1, see Assumptions) | | | |
| B1 | Host list and refusals; C1, C2, C3 | yes | | |
| B2 | Always the front door; set-up page; one volume | yes | | |
| B4 | Remove the single-wiki paths; C8; O4 and O5 by reading every route | yes | | |
| B5 | Tests on the front door only | | | |
| B6 | Old names and unused settings; C5, C6, C7 | | | |
| B7 | Docs; C4, C9; release notes; version bump left open | | | |
| — | `one-mode` → `main`, whole-branch review | yes | | |

## Stage 0 findings (B0)

Read on `one-mode` at `7b2c35b` (`main` after #270, the load-test harness).

### Readers of the removed variables

| Variable | Read by (non-test) |
| --- | --- |
| `GITQUIRE_WIKIS` | `docker/entrypoint.sh`; `front-door/settings.ts` (`wikisModeFromEnv`, error texts); `front-door/start.ts`; `index.ts` (single wiki refuses `GITQUIRE_HOSTS`); `front-door/move-over.ts`; `cli` `front-door` command; `loadtest/`; `prototypes.yml`, `h5_*.py`, `pp_rows.py` |
| `GITQUIRE_BEHIND_FRONT_DOOR` | `request-person.ts` (chooses the gate), `host/names.ts`, `front-door/wiki-processes.ts` (sets it for editors); with `GITQUIRE_REPO` also `wiki-name.ts`, `mentions.ts`, `chat-notifier.ts` |
| `GITQUIRE_REPO` | operator side: `front-door/settings.ts` (default wiki and default allowed owner), `move-over.ts`, `cli` `wikis` and `gitquire-bootstrap`, `entrypoint.sh`, `docker.yml`, `sync-e2e.sh`. Editor side (set by `wiki-processes.ts` for each editor): `github-auth-config.ts`, `github-app.ts`, `host/forgejo-repo.ts`, `door-token.ts`, `repo-pin.ts`, `routes.ts`, `semantic-search.ts`, `chat/setup.ts`, `wiki-name.ts`, `behind-front-door-gate.ts` |
| `GITQUIRE_HOST`, `GITQUIRE_HOST_URL`, `_API_URL` | operator side: `front-door/settings.ts` (first host), `hosts.ts` (reserved prefixes), `index.ts`, `host/data-folder.ts`, `entrypoint.sh`. Editor side: `host/names.ts`, `github-auth-config.ts`, `door-token.ts`, `host/forgejo-repo.ts`, `routes.ts`; `wiki-processes.ts` sets them per editor from the host record |
| `GITQUIRE_HOST_CLIENT_*`, `_TOKEN`, `_REPO_TOKEN` | `front-door/settings.ts`, `hosts.ts`, `host/forgejo-repo.ts`, `host/forgejo.ts`, `github-auth-config.ts`, `move-over*.ts`, `start.ts`; `drafts/instances.ts` strips them from drafts |
| `GITHUB_APP_*` | `front-door/settings.ts`, `github-auth-config.ts`, `github-app.ts`, `routes.ts`, `entrypoint.sh`, `docker.yml` (the "missing settings" check), `sync-e2e.sh` |
| `GITQUIRE_GITHUB_WEB_URL`, `_API_URL` | `front-door/settings.ts`; editor side `github-auth-config.ts`, `github-app.ts`, `door-token.ts` (set by `wiki-processes.ts`) |
| `GITQUIRE_ADMINS` | `front-door/settings.ts`; editor side `github-auth-config.ts`, `behind-front-door-gate.ts` (set by `wiki-processes.ts` from the host's administrators) |
| `GITQUIRE_ALLOWED_OWNERS` | `front-door/settings.ts`, `move-over.ts` |
| `GITQUIRE_ALLOWED_USERS`, `GITQUIRE_MCP_TOKEN`, `GITQUIRE_AUTH` | `github-auth-config.ts` (single-wiki gate), `routes.ts`; refused by `front-door/settings.ts` |
| `GITQUIRE_BRANCH` | `workspace.ts`, `github-app.ts`, `host/forgejo-repo.ts`, `door-token.ts`, `drafts/instances.ts`, `move-over.ts`, `sync-e2e.sh`. Never passed to editors by the front door (not in its allowlist) |
| `GITQUIRE_SYNC_MODE`, `GITQUIRE_AUTO_SYNC_MODE` | `index.ts`, `drafts/setup.ts`, `repo-bootstrap.ts`; `wiki-processes.ts` passes both from the operator's environment to every editor |
| `GITQUIRE_DRAFTS_DIR` | `drafts/store.ts`, `move-over.ts`, `deploy/compose.yaml` (the `/drafts` volume) |
| `GITQUIRE_ALLOW_EXTERNAL` | `Dockerfile` (`ENV`), `cli` `start`, `core` `config/env-layer.ts`, server `ingress-policy.ts`, `boot.ts`, `http-app.ts`, `mcp-mount.ts`, `collaboration-host.ts`; `wiki-processes.ts` sets it for editors (which bind to `127.0.0.1` and a socket) |
| `GITQUIRE_COMMIT_EMAIL_FORMAT` | `front-door/settings.ts`, `hosts.ts`, `host/names.ts`; `wiki-processes.ts` sets it per editor |

Two sides have to be told apart: the **operator's** environment, read by the front door, and the **editor's** environment, which `front-door/wiki-processes.ts` builds from an allowlist and the wiki's host record. Most "removed" names are read only on the editor side, where the front door sets them; the operator never reaches them except through the allowlist (`PASSED_SETTINGS`), which today passes `GITQUIRE_ADMINS`, `GITQUIRE_SYNC_MODE`, `GITQUIRE_AUTO_SYNC_MODE`, `GITQUIRE_COMMIT_EMAIL_FORMAT`, `GITQUIRE_HOST*` and `GITQUIRE_GITHUB_*_URL` from the operator (for the first host), the last ones overwritten by the host record.

### What the single-wiki start does that the front door does not

- `gitquire init` on an empty `/data` (a local folder with no host) and `GITQUIRE_AUTH=off`: replaced by the set-up page.
- A wiki on a branch other than the default (`GITQUIRE_BRANCH`): dropped by decision.
- People let in without write access (`GITQUIRE_ALLOWED_USERS`) and one shared agent token (`GITQUIRE_MCP_TOKEN`): dropped (O4).
- Sync mode `follow` or `off` for the whole server (`GITQUIRE_SYNC_MODE`): dropped; every wiki syncs both ways (`full`), as behind the front door by default today.
- The second volume `/drafts` (`GITQUIRE_DRAFTS_DIR`): the front door keeps drafts on `/data` already (`/data/wikis/.gitquire-drafts/`).
- Everything else an editor does (AGENTS.md, the data folder, sync, drafts, AI chat, mentions) runs in the editor process the front door starts, so nothing is lost.

### What starts a single-wiki server today

- `docker.yml`: the smoke test (`gq`, no sign-in), the Playwright suite `.github/e2e/gitquire.e2e.mjs` (`gq-e2e`, no sign-in), the sign-in check (`gq-auth`, `GITHUB_APP_*`), the "missing settings" check (`GITHUB_APP_ID=1` alone).
- `prototypes.yml`: the stage 0 rows (`gitquire init` in a volume), the single-wiki H5 rows (`gq-h5` on Forgejo with `GITQUIRE_HOST=forgejo`), `h5_adopt.py` (adopt and unadopt).
- `sync-nightly.yml` through `.github/scripts/sync-e2e.sh` (single wiki on the test GitHub App, `GITQUIRE_BRANCH`).
- Unit suites starting the single-wiki gate: `access-gate.test.ts`, `agent-gate.test.ts`, `oauth-server.test.ts`, `routes.test.ts` and others under `packages/server/src/gitquire/`; core and server suites around `GITQUIRE_ALLOW_EXTERNAL`.
- The load-test harness already starts the front door (`GITQUIRE_WIKIS=on`, first-host variables); only its names change.

### What the app shows without a wiki prefix

`lib/gitquire/wiki-prefix.ts` gives no prefix outside `/w/<key>/<owner>/<repo>/`; then `GitQuireWikiMenu` is not shown (plain `WebProjectName`), no `/api/front-door/…` call is made, storage keys have no namespace. Behind the front door a page always has the prefix, so these branches become dead once the single wiki is gone. They are browser code and harmless; removing them is listed for B4 if it stays small, otherwise left.

### Does anything break the design?

No. Two points shape how it is built:

- `gitquire wikis adopt` reads `GITQUIRE_REPO` and the first-host variables. Removing those in B1 would leave `adopt` half working until B3 deletes it, so **B3 is done before B1** (Assumption 1).
- The editor-side names are an internal interface of the front door. They are not the operator's settings (Assumption 2).

## Assumptions (change freely)

1. **Order:** B3 (remove moving over) comes before B1, because B1 removes the variables `adopt` reads; doing B3 first avoids adapting code that is deleted next. Otherwise the blocks keep the plan's order.
2. **Editor-side environment:** the variables the front door sets for its editor processes (`GITQUIRE_REPO`, `GITQUIRE_HOST`, `GITQUIRE_HOST_URL`, `GITQUIRE_ADMINS`, …) are the front door's internal interface, not settings. The operator's values for these names never reach an editor: the front door refuses them at start (B1), and the allowlist no longer passes any host, sync or administrator setting from the operator. Where B4 removes single-wiki code, names that only served it go; names still needed stay internal.
3. **CI:** pull requests into `one-mode` count as stacked and leave out the Docker job; each one gets the `full-ci` label so the image is built and smoke-tested on every block.
4. **Sync mode:** with `GITQUIRE_SYNC_MODE` gone, every wiki syncs both ways (`full`).
