# Review map for the `wikis-hosts` branch

One page for reviewers: who owns what, the requirements in one line each, and the seams where a mistake leaks one wiki into another or loses work. Updated in the pull request that changes what it describes. The plan is `plans/wikis-and-hosts.md`.

## Switches

`GITQUIRE_WIKIS` off and `GITQUIRE_HOST` unset must behave exactly as `main`. Any code path that runs with both off and differs from `main` is a finding.

## Who owns what

All paths under `packages/server/src/gitquire/` unless stated.

| Area | Module | Notes |
| --- | --- | --- |
| Start-up, content folder set-up | `index.ts`, `agents-file.ts`, `legacy-data-folder.ts` | Writes `AGENTS.md` and `.gitquire/` into the folder it starts on (R1) |
| Sign-in, session cookie, access check | `access-gate.ts`, `signed-cookie.ts`, `github-auth-config.ts` | GitHub OAuth, `GET /user`, repo `permissions`; one admin flag per cookie (R3) |
| GitQuire's own token on the host | `github-app.ts`, `repo-bootstrap.ts` | App JWT, installation token, basic auth `x-access-token` for Git |
| Agent tokens and `/mcp` sign-in | `agent-tokens.ts`, `agent-access.ts`, `oauth-server.ts`, `agent-pages.ts` | Re-check by collaborator permission; one revocation revokes all (R9, R13) |
| Drafts | `drafts/` (`service.ts`, `instances.ts`, `proxy.ts`, `http.ts`, `remote.ts`), `github-pulls.ts` | Child processes on free ports (R5); `DraftRemote` is the host seam for reviews |
| Internal calls | `internal-request.ts` | Shared secret between a process and its drafts |
| People and identity | `people.ts`, `principal-directory.ts`, `board-identity.ts` | Person id `<host prefix><number>` from `host/names.ts`, `github-` on GitHub (R16) |
| Mentions, mail, chat | `mentions.ts`, `page-scan.ts`, `mention-mailer.ts`, `mail.ts`, `chat-notifier.ts` | Read marks in `mentions.json` |
| Settings | `personal-settings.ts`, `settings-admin.ts`, `workspace.ts` | |
| App, server calls | `packages/app/src/lib/client-fetch.ts` (`apiOrigin`), `packages/app/src/editor/DocumentContext.tsx` (`storageNamespace`) | Prefix and per-wiki storage (block 3) |
| Live-editing address | `packages/server/src/collab-bootstrap-url.ts` | Built from the Host header |

Modules added by the branch are listed here by the pull request that adds them.

| Added | Module | Notes |
| --- | --- | --- |
| Stage 0 | `.github/workflows/prototypes.yml`, `.github/prototypes/` | Forgejo 15 in a container, the prototype front door (`front-proxy.mjs`) and the P and F rows; throwaway code kept as the base of H5. Not part of the product |
| Stage 2 (H5) | `prototypes.yml` job `forgejo-h5`, `.github/prototypes/h5_forgejo.py` | GitQuire's image against Forgejo 15 over https with a test authority: R17 start check, sign-in, sync both ways, a draft from start to publish, access removed, host down. Runs on pull requests that touch GitQuire's server code, Docker or the workflow, and on pushes to `wikis-hosts`. Not part of `ci-ok` |
| Stage 1 (H1, H3) | `host/types.ts` | **Contract.** The host interface: `DoorHost` (sign-in, `access`, `accessByBot` with `refused:token` (401), `refused:not-admin` (403), `refused:removed` (bot no longer reaches the repo) and `unreachable`, async `tokenFor`), `HostNames` (label, id prefix, no-reply email) |
| Stage 4 (block 4) | `host/types.ts` | Adds to `DoorHost`: `addableRepos(personToken)` (`listed` with owner and repo ids, `refused` with whose token, `unreachable`; `blocked: 'bot-not-admin'` on Forgejo), `repoById(id)` (`found` with a `HostRepoRecord` carrying host, ids and current names, `gone`, `refused`, `unreachable`), `health(repo)` (`ok`, `unreachable`, `refused:*`). `gone` means "not found with GitQuire's own credentials": deleted, or the app or bot no longer on the repo; a private repo does not tell which |
| Stage 4 | `host/github.ts` | With `app` (a JWT source) given: `tokenFor` mints a token limited to the one repo through `GET /repos/{o}/{r}/installation`, cached per repo and renewed 10 minutes before expiry; `accessByBot` and `health` use it; `repoById` finds the installation by minting with `repository_ids` (metadata only). Without `app`, as before: the one installation token. `addableRepos` uses the person's token only. Never returns the JWT or the key |
| Stage 4 | `host/forgejo.ts` | `repoTokens` store (the front door implements it): `tokenFor` returns the wiki's own limited token and refuses to return the unlimited bot token; `addableRepos` pages `GET /user/repos`, keeps admin repos the bot reaches (`GET /repositories/{id}` with the bot token); `repoById`; `health` from the bot (401, 403/404, not admin) and the limited token. A token limited to another repo still reads this repo's record (F5), so `health` cannot see a token entered for the wrong repo |
| Stage 4 | `host/renames.ts` | Pure `repoChange(stored, repoById answer)`: `same`, `renamed`, `moved` (owner id changed: re-check allowed owners, R18), `mismatch`, or the answer passed on |
| Stage 4 | `.github/prototypes/h5_door.mjs`, `h5_forgejo.py door` | Runs the Forgejo door functions above, from the TypeScript source, against the `forgejo-h5` Forgejo |
| Stage 1 | `host/github.ts` | The GitHub door host: authorize address, code exchange, `GET /user`, repo `permissions`, collaborator permission with the app token. Moved from `access-gate.ts` and `agent-access.ts` unchanged |
| Stage 1 | `host/names.ts` | `GITQUIRE_HOST` (only `github` in stage 1), `GITQUIRE_COMMIT_EMAIL_FORMAT`; the process's host names, read by `noreplyEmail` and `principalIdForUser` |
| Stage 2 (H2) | `host/forgejo.ts` | The Forgejo door host: sign-in with `response_type=code`, scope `read:user read:repository`, `grant_type`; access re-check with the **unlimited** bot token (404 then asks whether the bot still reaches the repo: `refused:removed`); `tokenFor` returns only the **repository-limited** token; `selfCheck` (version 15+, bot is repo admin, limited token can write; R17) |
| Stage 2 | `host/forgejo-repo.ts` | `GITQUIRE_HOST_*` settings and both tokens; the repo client for bootstrap and sync (limited token only, `https://` only) |
| Stage 2 | `forgejo-pulls.ts` | Drafts on Forgejo: pull requests, squash merge with title and the 405 retry (F10), branches by API, head filter done in GitQuire |
| Stage 2 | `drafts/instances.ts` | Draft processes no longer receive `GITQUIRE_HOST_TOKEN` or `GITQUIRE_HOST_TOKEN_FILE` (R12) |
| Stage 1 | `host/data-folder.ts` | Refuses a data folder recorded for another host, or used by GitHub people when the host is not GitHub; writes nothing for GitHub. Cannot see ids in comment threads committed to the repo |

## Contract files

Sent through `[[related.rules]]` in `.github/ai-review.toml` when a path they govern changes:

- `packages/server/src/gitquire/host/types.ts` (stage 1), for changes under `host/`, to `access-gate.ts`, `agent-access.ts`, `github-app.ts`, `github-pulls.ts` and `drafts/remote.ts`.

Planned: the "who is this request" function (block 1), the front door's access check (block 5).

## Seams where a mistake leaks or loses work

| Seam | What can go wrong | Requirement |
| --- | --- | --- |
| Header carrying the person from front door to editor process to draft | Trusted without the internal secret; dropped by the forwarding code | R2, R4 |
| Address translation (prefix, `Location`, cookie `Path`, `Referer` catch-all for images) | A request without a wiki in its address lands in the wrong wiki | P1, block 3 |
| Browser storage and tab session | Offline edits of one wiki replayed into another | P2, block 3 |
| Process pool and sockets | Traffic of one wiki handed to another process | R5 |
| Stopping a wiki or the container | Unpushed commits lost | R6 |
| Access re-check | "Unknown" or "refused" read as "allowed"; one denial revokes everything | R8, R9, R14, R15 |
| Host token handed to an editor process | A process gets a token for other repos; `tokenFor` returns the Forgejo bot token or anything but a one-repo token | R12 |
| Folder and id keys | A rename or a second host orphans a folder or mixes ids; `repoChange` reads an owner rename as a move or the reverse | R10, R16, R18 |
| Adding a wiki | A repo under an owner that is not allowed becomes a running wiki | R1, R18 |

## Requirements in one line

R1 nothing written into a repo not turned on · R2 one "who is this request", passed on every hop · R3 admin flag per wiki · R4 internal secret required behind the front door · R5 Unix sockets · R6 stop only when pushed and clean · R7 allowed-users and MCP token refused in several-wiki mode · R8 live connections re-checked on a timer · R9 agent tokens revoked only with no wiki left · R10 folders keyed by host and repo id · R11 uninstalled or bot removed means "disconnected", never deleted · R12 host credentials only in the front door · R13 one writer for agent tokens · R14 host unreachable (network, 5xx): inside stay, nobody new · R15 own token refused (401, 403): wiki disconnected · R16 host in every record and id, addresses looked up · R17 Forgejo version and bot admin checked at start · R18 only allowed owners' repos run as wikis, checked in the front door.
